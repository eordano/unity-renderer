import { Authenticator } from '@dcl/crypto'
import { EcsMathReadOnlyQuaternion, EcsMathReadOnlyVector3 } from '@dcl/ecs-math'
import { DEBUG, playerHeight, WORLD_EXPLORER } from 'config'
import future, { IFuture } from 'fp-future'
import { getSignedHeaders } from 'lib/decentraland/authentication/signedFetch'
import { arrayCleanup } from 'lib/javascript/arrayCleanup'
import { defaultLogger } from 'lib/logger'
import { trackError, trackEvent } from 'shared/analytics/trackEvent'
import { setDecentralandTime } from 'shared/apis/host/EnvironmentAPI'
import { reportScenesAroundParcel, setHomeScene } from 'shared/atlas/actions'
import { emotesRequest, wearablesRequest } from 'shared/catalogs/actions'
import { EmotesRequestFilters, WearablesRequestFilters } from 'shared/catalogs/types'
import { notifyStatusThroughChat } from 'shared/chat'
import { sendMessage } from 'shared/chat/actions'
import { sendPublicChatMessage } from 'shared/comms'
import { leaveChannel } from 'shared/friends/actions'
import {
  createChannel,
  getChannelInfo,
  getChannelMembers,
  getChannelMessages,
  getFriendRequests,
  getFriends,
  getFriendsWithDirectMessages,
  getJoinedChannels,
  getPrivateMessages,
  getUnseenMessagesByChannel,
  getUnseenMessagesByUser,
  joinChannel,
  markAsSeenChannelMessages,
  markAsSeenPrivateChatMessages,
  muteChannel,
  searchChannels
} from 'shared/friends/sagas'
import { areChannelsEnabled } from 'shared/friends/utils'
import { ReportFatalErrorWithUnityPayloadAsync } from 'shared/loading/ReportFatalError'
import { AVATAR_LOADING_ERROR } from 'shared/loading/types'
import { globalObservable } from 'shared/observables'
import { denyPortableExperiences, removeScenePortableExperience } from 'shared/portableExperiences/actions'
import { saveProfileDelta, sendProfileToRenderer } from 'shared/profiles/actions'
import { retrieveProfile } from 'shared/profiles/retrieveProfile'
import { setWorldLoadingRadius } from 'shared/scene-loader/actions'
import { logout, redirectToSignUp, signUp, signUpCancel } from 'shared/session/actions'
import { getCurrentIdentity, getCurrentUserId, hasWallet } from 'shared/session/selectors'
import { blockPlayers, mutePlayers, unblockPlayers, unmutePlayers } from 'shared/social/actions'
import { setRendererAvatarState } from 'shared/social/avatarTracker'
import { reportHotScenes } from 'shared/social/hotScenes'
import { store } from 'shared/store/isolatedStore'
import {
  AvatarRendererMessage,
  ChatMessage,
  CreateChannelPayload,
  FriendshipUpdateStatusMessage,
  GetChannelInfoPayload,
  GetChannelMembersPayload,
  GetChannelMessagesPayload,
  GetChannelsPayload,
  GetFriendRequestsPayload,
  GetFriendsPayload,
  GetFriendsWithDirectMessagesPayload,
  GetJoinedChannelsPayload,
  GetPrivateMessagesPayload,
  JoinOrCreateChannelPayload,
  LeaveChannelPayload,
  MarkChannelMessagesAsSeenPayload,
  MarkMessagesAsSeenPayload,
  MuteChannelPayload,
  WorldPosition
} from 'shared/types'
import {
  joinVoiceChat,
  leaveVoiceChat,
  requestToggleVoiceChatRecording,
  requestVoiceChatRecording,
  setAudioDevice,
  setVoiceChatPolicy,
  setVoiceChatVolume
} from 'shared/voiceChat/actions'
import { rendererSignalSceneReady } from 'shared/world/actions'
import {
  allScenesEvent,
  AllScenesEvents,
  getSceneWorkerBySceneID,
  getSceneWorkerBySceneNumber
} from 'shared/world/parcelSceneManager'
import { receivePositionReport } from 'shared/world/positionThings'
import { TeleportController } from 'shared/world/TeleportController'
import { setAudioStream } from './audioStream'
import { setDelightedSurveyEnabled } from './delightedSurvey'
import { GIFProcessor } from './gif-processor'
import { getUnityInstance } from './IUnityInterface'
import { handleRequestAudioDevices } from './managers/audio'
import { handlePerformanceReport } from './managers/performance'
import { handleJumpIn } from './managers/position'
import { handleSaveUserAvatar, RendererSaveProfile } from './managers/profiles'
import { handleSceneEvent } from './managers/scene'
import { handleUpdateFriendshipStatus } from './managers/social'
import { handleFetchBalanceOfMANA, handleSearchENSOwner } from './managers/web3'

declare const globalThis: { gifProcessor?: GIFProcessor; __debug_wearables: any }
export const futures: Record<string, IFuture<any>> = {}

type UnityEvent = any

type SystemInfoPayload = {
  graphicsDeviceName: string
  graphicsDeviceVersion: string
  graphicsMemorySize: number
  processorType: string
  processorCount: number
  systemMemorySize: number
}

// the BrowserInterface is a visitor for messages received from Unity
class BrowserInterface {
  startedFuture = future<void>()
  onUserInteraction = future<void>()

  /**
   * This is the only method that should be called publically in this class.
   * It dispatches "renderer messages" to the correct handlers.
   *
   * It has a fallback that doesn't fail to support future versions of renderers
   * and independant workflows for both teams.
   */
  public handleUnityMessage(type: string, message: any) {
    if (type in this) {
      ; (this as any)[type](message)
    } else {
      if (DEBUG) {
        defaultLogger.info(`Unknown message (did you forget to add ${type} to unity-interface/dcl.ts?)`, message)
      }
    }
  }

  public StartIsolatedMode() {
    defaultLogger.warn('StartIsolatedMode')
  }

  public StopIsolatedMode() {
    defaultLogger.warn('StopIsolatedMode')
  }

  public AllScenesEvent<T extends IEventNames>(data: AllScenesEvents<T>) {
    allScenesEvent(data)
  }

  /** Triggered when the camera moves */
  public ReportPosition(data: {
    position: EcsMathReadOnlyVector3
    rotation: EcsMathReadOnlyQuaternion
    playerHeight?: number
    immediate?: boolean
    cameraRotation?: EcsMathReadOnlyQuaternion
  }) {
    receivePositionReport(
      data.position,
      data.rotation,
      data.cameraRotation || data.rotation,
      data.playerHeight || playerHeight
    )
  }

  public ReportMousePosition(data: { id: string; mousePosition: EcsMathReadOnlyVector3 }) {
    futures[data.id].resolve(data.mousePosition)
  }

  public SceneEvent(data: { sceneId: string; sceneNumber: number; eventType: string; payload: any }) {
    handleSceneEvent(data)
  }

  public OpenWebURL(data: { url: string }) {
    globalObservable.emit('openUrl', data)
  }

  /** @deprecated */
  public PerformanceReport(data: Record<string, unknown>) {
    handlePerformanceReport(data)
  }

  /** @deprecated TODO: remove useBinaryTransform after SDK7 is fully in prod */
  public SystemInfoReport(data: SystemInfoPayload & { useBinaryTransform?: boolean }) {
    trackEvent('system info report', data)

    this.startedFuture.resolve()
  }

  public CrashPayloadResponse(data: { payload: any }) {
    getUnityInstance().crashPayloadResponseObservable.notifyObservers(JSON.stringify(data))
  }

  public PreloadFinished(_data: { sceneId: string; sceneNumber: number }) {
    // stub. there is no code about this in unity side yet
  }

  /** @deprecated */
  public Track(data: { name: string; properties: { key: string; value: string }[] | null }) {
    trackError('kernel:renderer', new Error('use of deprecated browserInterface "Track"'))
    const properties: Record<string, string> = {}
    if (data.properties) {
      for (const property of data.properties) {
        properties[property.key] = property.value
      }
    }

    trackEvent(data.name as UnityEvent, { context: properties.context || 'unity-event', ...properties })
  }

  /** @deprecated */
  public TriggerExpression(data: { id: string; timestamp: number }) {
    trackError('kernel:renderer', new Error('use of deprecated browserInterface "TriggerExpression"'))
    allScenesEvent({
      eventType: 'playerExpression',
      payload: {
        expressionId: data.id
      }
    })

    const body = `␐${data.id} ${data.timestamp}`

    sendPublicChatMessage(body)
  }

  public TermsOfServiceResponse(data: {
    sceneId: string
    sceneNumber: number
    accepted: boolean
    dontShowAgain: boolean
  }) {
    if (data.sceneNumber) {
      const sceneId = getSceneWorkerBySceneNumber(data.sceneNumber)?.loadableScene.id
      if (sceneId) {
        data.sceneId = sceneId
      }
    }

    trackEvent('TermsOfServiceResponse', data)
  }

  public MotdConfirmClicked() {
    if (!hasWallet(store.getState())) {
      globalObservable.emit('openUrl', { url: 'https://docs.decentraland.org/get-a-wallet/' })
    }
  }

  public GoTo(data: { x: number; y: number }) {
    notifyStatusThroughChat(`Jumped to ${data.x},${data.y}!`)
    TeleportController.goTo(data.x, data.y).then(
      () => { },
      () => { }
    )
  }

  public GoToMagic() {
    TeleportController.goToCrowd().catch((e) => defaultLogger.error('error goToCrowd', e))
  }

  public GoToCrowd() {
    TeleportController.goToCrowd().catch((e) => defaultLogger.error('error goToCrowd', e))
  }

  public LogOut() {
    store.dispatch(logout())
  }

  public RedirectToSignUp() {
    store.dispatch(redirectToSignUp())
  }

  public SaveUserInterests(interests: string[]) {
    if (!interests) {
      return
    }
    const unique = new Set<string>(interests)

    store.dispatch(saveProfileDelta({ interests: Array.from(unique) }))
  }

  public SaveUserAvatar(changes: RendererSaveProfile) {
    handleSaveUserAvatar(changes)
  }

  public SendPassport(passport: { name: string; email: string }) {
    store.dispatch(signUp(passport.email, passport.name))
  }

  public RequestOwnProfileUpdate() {
    const userId = getCurrentUserId(store.getState())
    if (userId) {
      store.dispatch(sendProfileToRenderer(userId))
    }
  }

  public SaveUserUnverifiedName(changes: { newUnverifiedName: string }) {
    store.dispatch(saveProfileDelta({ name: changes.newUnverifiedName, hasClaimedName: false }))
  }

  public SaveUserDescription(changes: { description: string }) {
    store.dispatch(saveProfileDelta({ description: changes.description }))
  }

  public GetFriends(getFriendsRequest: GetFriendsPayload) {
    getFriends(getFriendsRequest).catch(defaultLogger.error)
  }

  // @TODO! @deprecated
  public GetFriendRequests(getFriendRequestsPayload: GetFriendRequestsPayload) {
    trackError('kernel:renderer', new Error('use of deprecated browserInterface method "GetFriendsRequestsPayload"'))
    getFriendRequests(getFriendRequestsPayload).catch((err) => {
      defaultLogger.error('error getFriendRequestsDeprecate', err)
      trackError('kernel:social', new Error(`error getting friend requests ` + err.message))
    })
  }

  public async MarkMessagesAsSeen(userId: MarkMessagesAsSeenPayload) {
    if (userId.userId === 'nearby') return
    markAsSeenPrivateChatMessages(userId).catch((err) => {
      defaultLogger.error('error markAsSeenPrivateChatMessages', err),
        trackError('kernel:social', new Error(`error marking private messages as seen ${userId.userId} ` + err.message))
    })
  }

  public async GetPrivateMessages(getPrivateMessagesPayload: GetPrivateMessagesPayload) {
    getPrivateMessages(getPrivateMessagesPayload).catch((err) => {
      defaultLogger.error('error getPrivateMessages', err)
      trackError(
        'kernel:social',
        new Error(`error getting private messages ${getPrivateMessagesPayload.userId} ` + err.message)
      )
    })
  }

  public CloseUserAvatar(isSignUpFlow = false) {
    if (isSignUpFlow) {
      store.dispatch(signUpCancel())
    }
  }

  public SaveUserTutorialStep(data: { tutorialStep: number }) {
    store.dispatch(saveProfileDelta({ tutorialStep: data.tutorialStep }))
  }

  public SetInputAudioDevice(data: { deviceId: string }) {
    store.dispatch(setAudioDevice({ inputDeviceId: data.deviceId }))
  }

  public ControlEvent({ eventType, payload }: { eventType: string; payload: any }) {
    switch (eventType) {
      case 'SceneReady': {
        const { sceneId, sceneNumber } = payload
        store.dispatch(rendererSignalSceneReady(sceneId, sceneNumber))
        break
      }
      default: {
        defaultLogger.warn(`Unknown event type ${eventType}, ignoring`)
        break
      }
    }
  }

  public SendScreenshot(data: { id: string; encodedTexture: string }) {
    futures[data.id].resolve(data.encodedTexture)
  }

  public ReportBuilderCameraTarget(data: { id: string; cameraTarget: EcsMathReadOnlyVector3 }) {
    futures[data.id].resolve(data.cameraTarget)
  }

  /**
   * @deprecated
   */
  public UserAcceptedCollectibles(_data: { id: string }) { }

  /** @deprecated */
  public SetDelightedSurveyEnabled(data: { enabled: boolean }) {
    setDelightedSurveyEnabled(data.enabled)
  }

  public SetScenesLoadRadius(data: { newRadius: number }) {
    store.dispatch(setWorldLoadingRadius(Math.max(Math.round(data.newRadius), 1)))
  }

  public GetUnseenMessagesByUser() {
    getUnseenMessagesByUser()
  }

  public SetHomeScene(data: { sceneId: string; sceneCoords: string }) {
    if (data.sceneCoords) {
      store.dispatch(setHomeScene(data.sceneCoords))
    } else {
      store.dispatch(setHomeScene(data.sceneId))
    }
  }

  public async RequestAudioDevices() {
    await handleRequestAudioDevices()
  }

  public GetFriendsWithDirectMessages(getFriendsWithDirectMessagesPayload: GetFriendsWithDirectMessagesPayload) {
    getFriendsWithDirectMessages(getFriendsWithDirectMessagesPayload).catch(defaultLogger.error)
  }

  public ReportScene(data: { sceneId: string; sceneNumber: number }) {
    const sceneId = data.sceneId ?? getSceneWorkerBySceneNumber(data.sceneNumber)?.rpcContext.sceneData.id

    this.OpenWebURL({ url: `https://dcl.gg/report-user-or-scene?scene_or_name=${sceneId}` })
  }

  public ReportPlayer(data: { userId: string }) {
    this.OpenWebURL({
      url: `https://dcl.gg/report-user-or-scene?scene_or_name=${data.userId}`
    })
  }

  public BlockPlayer(data: { userId: string }) {
    store.dispatch(blockPlayers([data.userId]))
  }

  public UnblockPlayer(data: { userId: string }) {
    store.dispatch(unblockPlayers([data.userId]))
  }

  public RequestScenesInfoInArea(data: { parcel: { x: number; y: number }; scenesAround: number }) {
    store.dispatch(reportScenesAroundParcel(data.parcel, data.scenesAround))
  }

  public SetAudioStream(data: { url: string; play: boolean; volume: number }) {
    setAudioStream(data.url, data.play, data.volume).catch((err) => defaultLogger.log(err))
  }

  public SendChatMessage(data: { message: ChatMessage }) {
    store.dispatch(sendMessage(data.message))
  }

  public SetVoiceChatRecording(recordingMessage: { recording: boolean }) {
    store.dispatch(requestVoiceChatRecording(recordingMessage.recording))
  }

  public JoinVoiceChat() {
    this.onUserInteraction
      .then(() => {
        store.dispatch(joinVoiceChat())
      })
      .catch(defaultLogger.error)
  }

  public LeaveVoiceChat() {
    store.dispatch(leaveVoiceChat())
  }

  public ToggleVoiceChatRecording() {
    store.dispatch(requestToggleVoiceChatRecording())
  }

  public ApplySettings(settingsMessage: { voiceChatVolume: number; voiceChatAllowCategory: number }) {
    store.dispatch(setVoiceChatVolume(settingsMessage.voiceChatVolume))
    store.dispatch(setVoiceChatPolicy(settingsMessage.voiceChatAllowCategory))
  }

  // @TODO! @deprecated - With the new friend request flow, the only action that will be triggered by this message is FriendshipAction.DELETED.
  public UpdateFriendshipStatus(message: FriendshipUpdateStatusMessage) {
    trackError('kernel:renderer', new Error('use of deprecated browserInterface "UpdateFriendshipStatus"'))
    return handleUpdateFriendshipStatus(message)
  }

  public CreateChannel(createChannelPayload: CreateChannelPayload) {
    if (!areChannelsEnabled()) return
    createChannel(createChannelPayload).catch((err) => {
      defaultLogger.error('error createChannel', err)
      trackError(
        'kernel#friendsSaga',
        new Error(`error creating channel ${createChannelPayload.channelId} ${err.message}`)
      )
    })
  }

  public JoinOrCreateChannel(joinOrCreateChannelPayload: JoinOrCreateChannelPayload) {
    if (!areChannelsEnabled()) return
    joinChannel(joinOrCreateChannelPayload).catch((err) => {
      defaultLogger.error('error joinOrCreateChannel', err),
        trackEvent('error', {
          message: `error joining channel ${joinOrCreateChannelPayload.channelId} ` + err.message,
          context: 'kernel#friendsSaga',
          stack: 'joinOrCreateChannel'
        })
    })
  }

  public MarkChannelMessagesAsSeen(markChannelMessagesAsSeenPayload: MarkChannelMessagesAsSeenPayload) {
    if (!areChannelsEnabled()) return
    if (markChannelMessagesAsSeenPayload.channelId === 'nearby') return
    markAsSeenChannelMessages(markChannelMessagesAsSeenPayload).catch((err) => {
      defaultLogger.error('error markAsSeenChannelMessages', err),
        trackEvent('error', {
          message:
            `error marking channel messages as seen ${markChannelMessagesAsSeenPayload.channelId} ` + err.message,
          context: 'kernel#friendsSaga',
          stack: 'markAsSeenChannelMessages'
        })
    })
  }

  public GetChannelMessages(getChannelMessagesPayload: GetChannelMessagesPayload) {
    if (!areChannelsEnabled()) return
    getChannelMessages(getChannelMessagesPayload).catch((err) => {
      defaultLogger.error('error getChannelMessages', err),
        trackEvent('error', {
          message: `error getting channel messages ${getChannelMessagesPayload.channelId} ` + err.message,
          context: 'kernel#friendsSaga',
          stack: 'getChannelMessages'
        })
    })
  }

  public GetChannels(getChannelsPayload: GetChannelsPayload) {
    if (!areChannelsEnabled()) return
    searchChannels(getChannelsPayload).catch((err) => {
      defaultLogger.error('error searchChannels', err),
        trackEvent('error', {
          message: `error searching channels ` + err.message,
          context: 'kernel#friendsSaga',
          stack: 'searchChannels'
        })
    })
  }

  public GetChannelMembers(getChannelMembersPayload: GetChannelMembersPayload) {
    if (!areChannelsEnabled()) return
    getChannelMembers(getChannelMembersPayload).catch((err) => {
      defaultLogger.error('error getChannelMembers', err),
        trackEvent('error', {
          message: `error getChannelMembers ` + err.message,
          context: 'kernel#friendsSaga',
          stack: 'GetChannelMembers'
        })
    })
  }

  public GetUnseenMessagesByChannel() {
    if (!areChannelsEnabled()) return
    getUnseenMessagesByChannel()
  }

  public GetJoinedChannels(getJoinedChannelsPayload: GetJoinedChannelsPayload) {
    if (!areChannelsEnabled()) return
    getJoinedChannels(getJoinedChannelsPayload)
  }

  public LeaveChannel(leaveChannelPayload: LeaveChannelPayload) {
    if (!areChannelsEnabled()) return
    store.dispatch(leaveChannel(leaveChannelPayload.channelId))
  }

  public MuteChannel(muteChannelPayload: MuteChannelPayload) {
    if (!areChannelsEnabled()) return
    muteChannel(muteChannelPayload)
  }

  public GetChannelInfo(getChannelInfoPayload: GetChannelInfoPayload) {
    if (!areChannelsEnabled()) return
    getChannelInfo(getChannelInfoPayload)
  }

  public SearchENSOwner(data: { name: string; maxResults?: number }) {
    return handleSearchENSOwner(data)
  }

  public async JumpIn(data: WorldPosition) {
    handleJumpIn(data)
  }

  public async LoadingHUDReadyForTeleport(data: { x: number; y: number }) {
    TeleportController.LoadingHUDReadyForTeleport(data)
  }

  public async UpdateMemoryUsage() {
    getUnityInstance().SendMemoryUsageToRenderer()
  }

  public ScenesLoadingFeedback(_: { message: string; loadPercentage: number }) {
    defaultLogger.log('Deprecated method: ScenesLoadingFeedback')
    trackError('kernel:renderer', new Error('Attempted call: ScenesLoadingFeedback'))
  }

  public FetchHotScenes() {
    if (WORLD_EXPLORER) {
      reportHotScenes().catch((e: any) => {
        return defaultLogger.error('FetchHotScenes error', e)
      })
    }
  }

  public SetBaseResolution(data: { baseResolution: number }) {
    getUnityInstance().SetTargetHeight(data.baseResolution)
  }

  async RequestGIFProcessor(data: { imageSource: string; id: string; isWebGL1: boolean }) {
    if (!globalThis.gifProcessor) {
      globalThis.gifProcessor = new GIFProcessor(getUnityInstance().gameInstance, getUnityInstance(), data.isWebGL1)
    }

    globalThis.gifProcessor.ProcessGIF(data)
  }

  public DeleteGIF(data: { value: string }) {
    if (globalThis.gifProcessor) {
      globalThis.gifProcessor.DeleteGIF(data.value)
    }
  }

  public Web3UseResponse(data: { id: string; result: boolean }) {
    if (data.result) {
      futures[data.id].resolve(true)
    } else {
      futures[data.id].reject(new Error('Web3 operation rejected'))
    }
  }

  public FetchBalanceOfMANA() {
    return handleFetchBalanceOfMANA()
  }

  public SetMuteUsers(data: { usersId: string[]; mute: boolean }) {
    if (data.mute) {
      store.dispatch(mutePlayers(data.usersId))
    } else {
      store.dispatch(unmutePlayers(data.usersId))
    }
  }

  public async KillPortableExperience(data: { portableExperienceId: string }): Promise<void> {
    store.dispatch(removeScenePortableExperience(data.portableExperienceId))
  }

  public async SetDisabledPortableExperiences(data: { idsToDisable: string[] }): Promise<void> {
    store.dispatch(denyPortableExperiences(data.idsToDisable))
  }

  public RequestBIWCatalogHeader() {
    defaultLogger.warn('RequestBIWCatalogHeader')
  }

  public RequestHeaderForUrl(_data: { method: string; url: string }) {
    defaultLogger.warn('RequestHeaderForUrl')
  }

  public RequestSignedHeaderForBuilder(_data: { method: string; url: string }) {
    defaultLogger.warn('RequestSignedHeaderForBuilder')
  }

  // Note: This message is deprecated and should be deleted in the future.
  //       It is here until the Builder API is stabilized and uses the same signedFetch method as the rest of the platform
  public RequestSignedHeader(data: { method: string; url: string; metadata: Record<string, any> }) {
    const identity = getCurrentIdentity(store.getState())

    const headers: Record<string, string> = identity
      ? getSignedHeaders(data.method, data.url, data.metadata, (_payload) =>
        Authenticator.signPayload(identity, data.url)
      )
      : {}

    getUnityInstance().SendHeaders(data.url, headers)
  }

  public async PublishSceneState(data) {
    defaultLogger.warn('PublishSceneState', data)
  }

  public RequestWearables(data: {
    filters: {
      ownedByUser: string | null
      wearableIds?: string[] | null
      collectionIds?: string[] | null
      thirdPartyId?: string | null
    }
    context?: string
  }) {
    const { filters, context } = data
    const newFilters: WearablesRequestFilters = {
      ownedByUser: filters.ownedByUser ?? undefined,
      thirdPartyId: filters.thirdPartyId ?? undefined,
      wearableIds: arrayCleanup(filters.wearableIds),
      collectionIds: arrayCleanup(filters.collectionIds)
    }
    store.dispatch(wearablesRequest(newFilters, context))
  }

  public RequestEmotes(data: {
    filters: {
      ownedByUser: string | null
      emoteIds?: string[] | null
      collectionIds?: string[] | null
      thirdPartyId?: string | null
    }
    context?: string
  }) {
    const { filters, context } = data
    const newFilters: EmotesRequestFilters = {
      ownedByUser: filters.ownedByUser ?? undefined,
      thirdPartyId: filters.thirdPartyId ?? undefined,
      emoteIds: arrayCleanup(filters.emoteIds),
      collectionIds: arrayCleanup(filters.collectionIds)
    }
    store.dispatch(emotesRequest(newFilters, context))
  }

  public RequestUserProfile(userIdPayload: { value: string }) {
    retrieveProfile(userIdPayload.value, undefined).catch(defaultLogger.error)
  }

  public ReportAvatarFatalError(payload: any) {
    defaultLogger.error(payload)
    ReportFatalErrorWithUnityPayloadAsync(
      new Error(AVATAR_LOADING_ERROR + ' ' + JSON.stringify(payload)),
      'renderer#avatars'
    )
  }

  public UnpublishScene(_data: any) {
    // deprecated
  }

  public async NotifyStatusThroughChat(data: { value: string }) {
    notifyStatusThroughChat(data.value)
  }

  public VideoProgressEvent(videoEvent: {
    componentId: string
    sceneId: string
    sceneNumber: number
    videoTextureId: string
    status: number
    currentOffset: number
    videoLength: number
  }) {
    const scene = videoEvent.sceneNumber
      ? getSceneWorkerBySceneNumber(videoEvent.sceneNumber)
      : getSceneWorkerBySceneID(videoEvent.sceneId)
    if (scene) {
      scene.rpcContext.sendSceneEvent('videoEvent' as IEventNames, {
        componentId: videoEvent.componentId,
        videoClipId: videoEvent.videoTextureId,
        videoStatus: videoEvent.status,
        currentOffset: videoEvent.currentOffset,
        totalVideoLength: videoEvent.videoLength
      })
    } else {
      if (videoEvent.sceneId) defaultLogger.error(`SceneEvent: Scene id ${videoEvent.sceneId} not found`, videoEvent)
      else defaultLogger.error(`SceneEvent: Scene number ${videoEvent.sceneNumber} not found`, videoEvent)
    }
  }

  public ReportAvatarState(data: AvatarRendererMessage) {
    setRendererAvatarState(data)
  }

  public ReportDecentralandTime(data: any) {
    setDecentralandTime(data)
  }

  public ReportLog(data: { type: string; message: string }) {
    const logger = getUnityInstance().logger
    switch (data.type) {
      case 'trace':
        logger.trace(data.message)
        break
      case 'info':
        logger.info(data.message)
        break
      case 'warn':
        logger.warn(data.message)
        break
      case 'error':
        logger.error(data.message)
        break
      default:
        logger.log(data.message)
        break
    }
  }
}

export const browserInterface: BrowserInterface = new BrowserInterface()
