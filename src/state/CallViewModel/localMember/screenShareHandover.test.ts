/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// Regression tests for screen shares surviving a connection recycle.
//
// When the local connection is recycled (transport switch or blip), the
// Publisher is destroyed and rebuilt. Previously this unpublished and STOPPED
// the screen share capture, and nothing ever re-published it, so the share
// silently died while mic/cam recovered. The fix detaches the live capture
// tracks from the old publisher (unpublish without stop) and lets the
// replacement publisher adopt and re-publish them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionState as LivekitConnectionState,
  LocalParticipant,
  type LocalTrack,
  type LocalTrackPublication,
  Track,
  type TrackPublishOptions,
} from "livekit-client";
import { BehaviorSubject } from "rxjs";
import { logger } from "matrix-js-sdk/lib/logger";

import { constant } from "../../Behavior";
import {
  flushPromises,
  mockLivekitRoom,
  mockMediaDevices,
} from "../../../utils/test";
import { Publisher } from "./Publisher";
import { type Connection } from "../remoteMembers/Connection";
import { type MuteStates } from "../../MuteStates";
import {
  rnnoiseNoiseSuppression,
  rnnoiseNoiseSuppressionPreset,
} from "../../../settings/settings";

function createMockLocalTrack(
  source: Track.Source,
  readyState: MediaStreamTrackState = "live",
): LocalTrack {
  const kind =
    source === Track.Source.Camera || source === Track.Source.ScreenShare
      ? Track.Kind.Video
      : Track.Kind.Audio;
  return {
    source,
    kind,
    isMuted: false,
    isUpstreamPaused: false,
    mediaStreamTrack: { readyState } as MediaStreamTrack,
    stop: vi.fn(),
    pauseUpstream: vi.fn(),
    resumeUpstream: vi.fn(),
  } as Partial<LocalTrack> as LocalTrack;
}

function createMockPublication(source: Track.Source): LocalTrackPublication {
  const track = createMockLocalTrack(source);
  return {
    track,
    source,
    kind: track.kind,
  } as Partial<LocalTrackPublication> as LocalTrackPublication;
}

function createMockMuteState(enabled$: BehaviorSubject<boolean>): {
  enabled$: BehaviorSubject<boolean>;
  syncing$: BehaviorSubject<boolean>;
  setHandler: (h: (enabled: boolean) => void) => void;
  unsetHandler: () => void;
} {
  return {
    enabled$,
    syncing$: new BehaviorSubject(false),
    setHandler: vi.fn(),
    unsetHandler: vi.fn(),
  };
}

describe("Publisher screen share handover", () => {
  let publisher: Publisher;
  let localParticipant: LocalParticipant;
  let trackPublications: LocalTrackPublication[];
  let unpublishTrackMock: ReturnType<typeof vi.fn>;
  let publishTrackMock: ReturnType<typeof vi.fn>;

  function seedScreenSharePublications(): {
    video: LocalTrackPublication;
    audio: LocalTrackPublication;
  } {
    const video = createMockPublication(Track.Source.ScreenShare);
    const audio = createMockPublication(Track.Source.ScreenShareAudio);
    trackPublications.push(video, audio);
    return { video, audio };
  }

  beforeEach(() => {
    rnnoiseNoiseSuppression.setValue(false);
    rnnoiseNoiseSuppressionPreset.setValue("conservative");
    trackPublications = [];

    const mockEngine = {
      client: {
        sendUpdateLocalMetadata: vi.fn(),
      },
      on: vi.fn().mockReturnThis(),
      sendDataPacket: vi.fn(),
    };

    localParticipant = new LocalParticipant(
      "local-sid",
      "local-identity",
      // @ts-expect-error - we want a real LocalParticipant like Publisher.test.ts does
      mockEngine,
      {
        adaptiveStream: true,
        dynacase: false,
        audioCaptureDefaults: {},
        videoCaptureDefaults: {},
        stopLocalTrackOnUnpublish: true,
        reconnectPolicy: "always",
        disconnectOnPageLeave: true,
      },
      new Map(),
      {},
      {},
      {},
    );

    localParticipant.getTrackPublication = vi
      .fn()
      .mockImplementation((source: Track.Source) =>
        trackPublications.find((pub) => pub.track?.source === source),
      ) as unknown as LocalParticipant["getTrackPublication"];

    unpublishTrackMock = vi
      .fn()
      .mockImplementation(
        async (
          track: LocalTrack,
          _stopOnUnpublish?: boolean,
        ): Promise<LocalTrackPublication | undefined> => {
          const index = trackPublications.findIndex(
            (pub) => pub.track === track,
          );
          if (index === -1) return undefined;
          const [publication] = trackPublications.splice(index, 1);
          return publication;
        },
      );
    localParticipant.unpublishTrack =
      unpublishTrackMock as unknown as LocalParticipant["unpublishTrack"];

    publishTrackMock = vi
      .fn()
      .mockImplementation(async (track: LocalTrack) => {
        const publication = {
          track,
          source: track.source,
          kind: track.kind,
        } as Partial<LocalTrackPublication> as LocalTrackPublication;
        trackPublications.push(publication);
        return publication;
      });
    localParticipant.publishTrack =
      publishTrackMock as unknown as LocalParticipant["publishTrack"];

    const muteStates = {
      audio: createMockMuteState(new BehaviorSubject(false)),
      video: createMockMuteState(new BehaviorSubject(false)),
    } as unknown as MuteStates;

    const room = mockLivekitRoom({ localParticipant });
    // The pending-publish loop only publishes on a connected room (livekit
    // would otherwise defer with a track-stopping timeout). Marking the mock
    // room connected also unlocks the device-sync paths, so stub those too.
    Object.assign(room, {
      state: LivekitConnectionState.Connected,
      getActiveDevice: vi.fn().mockReturnValue(undefined),
      switchActiveDevice: vi.fn().mockResolvedValue(true),
    });
    const connection = {
      state$: constant({
        state: "ConnectedToLkRoom",
        livekitConnectionState$: constant(LivekitConnectionState.Connected),
      }),
      livekitRoom: room,
    } as unknown as Connection;

    publisher = new Publisher(
      connection,
      mockMediaDevices({}),
      muteStates,
      constant({ supported: false, processor: undefined }),
      logger,
    );
  });

  afterEach(async () => {
    await publisher.destroy();
  });

  it("stopTracks() unpublishes the screen share audio track along with the rest", async () => {
    const { video, audio } = seedScreenSharePublications();

    await publisher.stopTracks();

    expect(unpublishTrackMock).toHaveBeenCalledWith(video.track, true);
    expect(unpublishTrackMock).toHaveBeenCalledWith(audio.track, true);
    expect(
      localParticipant.getTrackPublication(Track.Source.ScreenShareAudio),
    ).toBeUndefined();
  });

  it("detachScreenShareTracks() unpublishes without stopping and returns the live tracks", async () => {
    const { video, audio } = seedScreenSharePublications();

    const detached = await publisher.detachScreenShareTracks();

    expect(detached).toEqual([video.track, audio.track]);
    expect(unpublishTrackMock).toHaveBeenCalledWith(video.track, false);
    expect(unpublishTrackMock).toHaveBeenCalledWith(audio.track, false);
    expect(video.track!.stop).not.toHaveBeenCalled();
    expect(audio.track!.stop).not.toHaveBeenCalled();
  });

  it("adopted tracks are re-published when the publisher starts publishing", async () => {
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);
    const audioTrack = createMockLocalTrack(Track.Source.ScreenShareAudio);
    const publishOptions: TrackPublishOptions = {
      videoCodec: "vp9",
      screenShareEncoding: { maxBitrate: 123, maxFramerate: 30 },
    };

    publisher.adoptScreenShareTracks([videoTrack, audioTrack], publishOptions);
    // Not publishing yet: the tracks are only stashed.
    expect(publishTrackMock).not.toHaveBeenCalled();
    expect(publisher.pendingScreenShare$.value).toBe(true);

    await publisher.startPublishing();
    await flushPromises();

    expect(publishTrackMock).toHaveBeenCalledWith(videoTrack, {
      ...publishOptions,
      source: Track.Source.ScreenShare,
    });
    expect(publishTrackMock).toHaveBeenCalledWith(audioTrack, {
      source: Track.Source.ScreenShareAudio,
    });
    expect(publisher.pendingScreenShare$.value).toBe(false);
  });

  it("adopted tracks are re-published immediately if already publishing", async () => {
    await publisher.startPublishing();
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);

    publisher.adoptScreenShareTracks([videoTrack]);
    await flushPromises();

    expect(publishTrackMock).toHaveBeenCalledWith(videoTrack, {
      source: Track.Source.ScreenShare,
    });
  });

  it("stops and drops tracks whose capture ended instead of publishing them", async () => {
    await publisher.startPublishing();
    const liveTrack = createMockLocalTrack(Track.Source.ScreenShare);
    const endedTrack = createMockLocalTrack(
      Track.Source.ScreenShareAudio,
      "ended",
    );

    publisher.adoptScreenShareTracks([liveTrack, endedTrack]);
    await flushPromises();

    expect(endedTrack.stop).toHaveBeenCalled();
    expect(publishTrackMock).toHaveBeenCalledTimes(1);
    expect(publishTrackMock).toHaveBeenCalledWith(liveTrack, {
      source: Track.Source.ScreenShare,
    });
  });

  it("re-checks liveness at publish time: a track that ended while stashed is not published", async () => {
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);
    publisher.adoptScreenShareTracks([videoTrack]);

    // The capture ends while the track is stashed (e.g. browser stop bar).
    (videoTrack.mediaStreamTrack as { readyState: MediaStreamTrackState }).readyState =
      "ended";
    await publisher.startPublishing();
    await flushPromises();

    expect(publishTrackMock).not.toHaveBeenCalled();
    expect(videoTrack.stop).toHaveBeenCalled();
  });

  it("detachScreenShareTracks() also hands back adopted tracks that were never re-published", async () => {
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);
    publisher.adoptScreenShareTracks([videoTrack]);

    const detached = await publisher.detachScreenShareTracks();

    expect(detached).toEqual([videoTrack]);
    expect(publishTrackMock).not.toHaveBeenCalled();
    expect(videoTrack.stop).not.toHaveBeenCalled();
    expect(publisher.pendingScreenShare$.value).toBe(false);
  });

  it("detachScreenShareTracks() steals a track whose re-publish is still in flight", async () => {
    await publisher.startPublishing();
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);
    let resolvePublish!: (value: LocalTrackPublication) => void;
    publishTrackMock.mockImplementationOnce(
      () =>
        new Promise<LocalTrackPublication>((resolve) => {
          resolvePublish = resolve;
        }),
    );

    publisher.adoptScreenShareTracks([videoTrack]);
    expect(publishTrackMock).toHaveBeenCalledTimes(1);

    // A second recycle hits while the publish is deferred: the track is in
    // neither the stash nor the publications, but detach must still find it.
    // Detach waits for the in-flight publish to settle before returning.
    const detachPromise = publisher.detachScreenShareTracks();
    resolvePublish({
      track: videoTrack,
      source: videoTrack.source,
      kind: videoTrack.kind,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);
    const detached = await detachPromise;
    expect(detached).toEqual([videoTrack]);
    expect(videoTrack.stop).not.toHaveBeenCalled();

    // The stolen track's publication is released without stopping the
    // capture, and everything has settled by the time detach returned.
    await flushPromises();
    expect(unpublishTrackMock).toHaveBeenCalledWith(videoTrack, false);
    expect(videoTrack.stop).not.toHaveBeenCalled();
  });

  it("detachScreenShareTracks() recovers the whole batch while the first publish is in flight", async () => {
    await publisher.startPublishing();
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);
    const audioTrack = createMockLocalTrack(Track.Source.ScreenShareAudio);
    let resolvePublish!: (value: LocalTrackPublication) => void;
    publishTrackMock.mockImplementationOnce(
      () =>
        new Promise<LocalTrackPublication>((resolve) => {
          resolvePublish = resolve;
        }),
    );

    publisher.adoptScreenShareTracks([videoTrack, audioTrack]);
    await flushPromises();
    // Video publish is deferred; the audio track must still be in the stash.
    expect(publishTrackMock).toHaveBeenCalledTimes(1);

    const detachPromise = publisher.detachScreenShareTracks();
    resolvePublish({
      track: videoTrack,
      source: videoTrack.source,
      kind: videoTrack.kind,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);
    const detached = await detachPromise;
    // BOTH tracks are recovered: audio from the stash, video via steal.
    expect(detached).toEqual(expect.arrayContaining([videoTrack, audioTrack]));
    expect(detached).toHaveLength(2);
    expect(audioTrack.stop).not.toHaveBeenCalled();
    expect(videoTrack.stop).not.toHaveBeenCalled();

    // The audio track is never published onto this (dying) publisher.
    await flushPromises();
    expect(publishTrackMock).toHaveBeenCalledTimes(1);
    expect(audioTrack.stop).not.toHaveBeenCalled();
  });

  it("detachScreenShareTracks() does not resolve until the stolen publish settles", async () => {
    await publisher.startPublishing();
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);
    let resolvePublish!: (value: LocalTrackPublication) => void;
    publishTrackMock.mockImplementationOnce(
      () =>
        new Promise<LocalTrackPublication>((resolve) => {
          resolvePublish = resolve;
        }),
    );
    publisher.adoptScreenShareTracks([videoTrack]);

    let detachResolved = false;
    const detachPromise = publisher.detachScreenShareTracks().then((tracks) => {
      detachResolved = true;
      return tracks;
    });
    await flushPromises();
    // The handover must not complete while the stolen publish is unsettled —
    // otherwise its late continuation could outlive the handover.
    expect(detachResolved).toBe(false);

    resolvePublish({
      track: videoTrack,
      source: videoTrack.source,
      kind: videoTrack.kind,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);
    const detached = await detachPromise;
    expect(detached).toEqual([videoTrack]);
  });

  it("hands tracks over even when an unpublish fails on the dying connection", async () => {
    const { video, audio } = seedScreenSharePublications();
    unpublishTrackMock.mockRejectedValueOnce(new Error("negotiation timeout"));

    const detached = await publisher.detachScreenShareTracks();

    // The failed unpublish must not drop the live track from the handover —
    // that would leave a capture nothing references.
    expect(detached).toEqual(expect.arrayContaining([video.track, audio.track]));
    expect(detached).toHaveLength(2);
    expect(video.track!.stop).not.toHaveBeenCalled();
    expect(audio.track!.stop).not.toHaveBeenCalled();
  });

  it("discardPendingScreenShare() mid-batch stops the stashed audio too", async () => {
    await publisher.startPublishing();
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);
    const audioTrack = createMockLocalTrack(Track.Source.ScreenShareAudio);
    let resolvePublish!: (value: LocalTrackPublication) => void;
    publishTrackMock.mockImplementationOnce(
      () =>
        new Promise<LocalTrackPublication>((resolve) => {
          resolvePublish = resolve;
        }),
    );

    publisher.adoptScreenShareTracks([videoTrack, audioTrack]);
    await flushPromises();

    // User stops sharing while the video publish is still in flight.
    publisher.discardPendingScreenShare();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
    expect(publisher.pendingScreenShare$.value).toBe(false);

    // The loop must not publish the audio track after the discard.
    resolvePublish({
      track: videoTrack,
      source: videoTrack.source,
      kind: videoTrack.kind,
    } as Partial<LocalTrackPublication> as LocalTrackPublication);
    await flushPromises();
    expect(publishTrackMock).toHaveBeenCalledTimes(1);
  });

  it("discardPendingScreenShare() stops a stashed share (user toggled off mid-handover)", () => {
    const videoTrack = createMockLocalTrack(Track.Source.ScreenShare);
    publisher.adoptScreenShareTracks([videoTrack]);

    publisher.discardPendingScreenShare();

    expect(videoTrack.stop).toHaveBeenCalled();
    expect(publisher.pendingScreenShare$.value).toBe(false);
  });
});
