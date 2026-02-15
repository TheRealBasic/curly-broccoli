import { FormEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  APP_NAME,
  type ChannelSummary,
  type ChatMessage,
  type DmMessage,
  type DmThreadSummary,
  type ServerEvent,
  type ServerMember,
  type VoiceParticipant,
  type AttachmentCategory,
  type ServerSummary,
  type StreamType,
  type CoWatchPlaybackState,
  type CoWatchMediaSource,
  type VoiceEffectMode,
} from '@curly-broccoli/shared';

type ConnectionState = 'connecting' | 'open' | 'closed';

type AuthState = {
  user: { id: string; username: string };
  accessToken: string;
  refreshToken: string;
};

type AuthMode = 'login' | 'register';

type ModerationAuditLog = {
  id: string;
  serverId: string;
  actorUserId: string;
  actorUsername: string;
  targetUserId: string | null;
  targetUsername: string | null;
  messageId: string | null;
  action:
    | 'message_delete'
    | 'message_report'
    | 'user_mute'
    | 'user_unmute'
    | 'member_permission_update'
    | 'screen_share_start'
    | 'screen_share_stop'
    | 'screen_share_force_stop';
  details: unknown;
  createdAt: string;
};

type PendingAttachmentUpload = {
  localId: string;
  fileName: string;
  mimeType: string;
  category: AttachmentCategory;
  progress: number;
  status: 'uploading' | 'uploaded' | 'failed';
  previewUrl: string | null;
  attachmentId?: string;
};

type PeerConnectionHealth = 'connecting' | 'connected' | 'failed' | 'restarting';

type VoiceRuntimeMetrics = {
  joinAttempts: number;
  joinSuccesses: number;
  setupDurationsMs: number[];
  disconnectCauses: Record<string, number>;
};

type ScreenContentType = 'text' | 'mixed' | 'motion';

type ScreenEncodingPreset = {
  maxBitrateBps: number;
  maxFramerate: number;
};

type RollingClipChunk = {
  blob: Blob;
  capturedAt: number;
};

type HighlightRecorderState = 'disabled' | 'buffering' | 'saving';

const AUTH_STORAGE_KEY = 'curly_broccoli_auth';
const DESKTOP_NOTIFICATIONS_STORAGE_KEY = 'curly_broccoli_desktop_notifications_enabled';
const SPATIAL_AUDIO_STORAGE_KEY = 'curly_broccoli_spatial_audio_enabled';
const TYPING_STOP_DELAY_MS = 1200;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 12_000;
const SCREEN_P2P_PARTICIPANT_THRESHOLD = 6;
const SCREEN_ADAPT_INTERVAL_MS = 4_000;
const SOUNDBOARD_CLIPS: { id: string; label: string; frequency: number; durationMs: number }[] = [
  { id: 'boing', label: 'Boing', frequency: 340, durationMs: 280 },
  { id: 'sparkle', label: 'Sparkle', frequency: 520, durationMs: 220 },
  { id: 'dramatic', label: 'Dramatic', frequency: 180, durationMs: 520 },
];

const SCREEN_PRESETS: Record<ScreenContentType, ScreenEncodingPreset> = {
  text: { maxBitrateBps: 600_000, maxFramerate: 8 },
  mixed: { maxBitrateBps: 1_200_000, maxFramerate: 15 },
  motion: { maxBitrateBps: 2_500_000, maxFramerate: 30 },
};
const HIGHLIGHT_BUFFER_MS = 30_000;
const HIGHLIGHT_CHUNK_MS = 1_000;
const AI_MODEL_OPTIONS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'] as const;

type NotificationPermissionState = 'unsupported' | NotificationPermission;

type MentionSegment = {
  text: string;
  mentioned: boolean;
};

type RemoteAudioNodes = {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  spatial: boolean;
  panner: PannerNode | null;
  gain: GainNode | null;
};

type StreamingAiReply = {
  requestId: string;
  channelId: string;
  botDisplayName: string;
  requestedByUserId: string;
  text: string;
};

type AiInvocationPolicy = 'everyone' | 'roles';

type ServerAiStatus = {
  enabled: boolean;
  keyMissing: boolean;
  budgetReached: boolean;
  degradedMode: boolean;
};

type ServerAiSettings = {
  serverId: string;
  enabled: boolean;
  botDisplayName: string;
  model: string;
  systemPrompt: string | null;
  maxTokensPerReply: number | null;
  temperature: number | null;
  invocationPolicy: AiInvocationPolicy;
  status: ServerAiStatus;
};

function isRtcSessionDescriptionInit(value: unknown): value is RTCSessionDescriptionInit {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { type?: unknown; sdp?: unknown };
  return (
    (candidate.type === 'offer'
      || candidate.type === 'answer'
      || candidate.type === 'pranswer'
      || candidate.type === 'rollback')
    && (typeof candidate.sdp === 'string' || typeof candidate.sdp === 'undefined')
  );
}


export function disposeRemoteAudioNodes(nodes: RemoteAudioNodes) {
  nodes.source.disconnect();
  nodes.analyser.disconnect();
  nodes.panner?.disconnect();
  nodes.gain?.disconnect();
}

function loadAuthState() {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AuthState;
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

function saveAuthState(value: AuthState | null) {
  if (!value) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }

  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value));
}

function loadDesktopNotificationsEnabled() {
  return localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY) === 'true';
}

function saveDesktopNotificationsEnabled(value: boolean) {
  localStorage.setItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY, String(value));
}

function loadSpatialAudioEnabled() {
  return localStorage.getItem(SPATIAL_AUDIO_STORAGE_KEY) === 'true';
}

function saveSpatialAudioEnabled(value: boolean) {
  localStorage.setItem(SPATIAL_AUDIO_STORAGE_KEY, String(value));
}

export function getSpatialPositionFromIndex(index: number, total: number) {
  if (total <= 1) {
    return { x: 0, y: 0, z: -1.5 };
  }

  const spreadStart = -Math.PI / 3;
  const spreadEnd = Math.PI / 3;
  const angle = spreadStart + (index / (total - 1)) * (spreadEnd - spreadStart);
  const radius = 1.8;
  return {
    x: Math.sin(angle) * radius,
    y: 0,
    z: -Math.cos(angle) * radius,
  };
}

function parseMentionSegments(text: string) {
  const mentionRegex = /(@[a-z0-9_]{3,32})/gi;
  const parts = text.split(mentionRegex);
  return parts
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      mentioned: /^@[a-z0-9_]{3,32}$/i.test(part),
    })) satisfies MentionSegment[];
}

function containsMentionForUser(text: string, username: string) {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionPattern = new RegExp(`(^|[^a-z0-9_])@${escaped}(?=$|[^a-z0-9_])`, 'i');
  return mentionPattern.test(text);
}

function previewText(text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return '[image]';
  }

  return normalized.length > 70 ? `${normalized.slice(0, 67)}...` : normalized;
}

function deriveAttachmentCategory(mimeType: string): AttachmentCategory {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('text/') || mimeType.startsWith('application/')) return 'document';
  return 'other';
}

function attachmentIcon(category: AttachmentCategory) {
  if (category === 'audio') return '🎵';
  if (category === 'video') return '🎬';
  if (category === 'document') return '📄';
  if (category === 'other') return '📎';
  return '🖼️';
}

export function App() {
  const apiBase = ((import.meta as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL) ?? 'http://localhost:4000';
  const socketRef = useRef<WebSocket | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const isTypingRef = useRef(false);
  const activeChannelRef = useRef<string | null>(null);
  const activeDmThreadRef = useRef<string | null>(null);
  const chatModeRef = useRef<'channel' | 'dm'>('channel');
  const desktopNotificationsEnabledRef = useRef(false);
  const notificationPermissionRef = useRef<NotificationPermissionState>('unsupported');
  const localVoiceStreamRef = useRef<MediaStream | null>(null);
  const processedLocalVoiceStreamRef = useRef<MediaStream | null>(null);
  const localAudioContextRef = useRef<AudioContext | null>(null);
  const localGainNodeRef = useRef<GainNode | null>(null);
  const soundboardLimiterNodeRef = useRef<DynamicsCompressorNode | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteAudioByUserIdRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const peerChannelByUserIdRef = useRef<Map<string, string>>(new Map());
  const heartbeatIntervalRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const currentSocketRef = useRef<WebSocket | null>(null);
  const peerSetupStartRef = useRef<Map<string, number>>(new Map());
  const voiceMetricsRef = useRef<VoiceRuntimeMetrics>({
    joinAttempts: 0,
    joinSuccesses: 0,
    setupDurationsMs: [],
    disconnectCauses: {},
  });
  const remoteAudioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioNodesByUserIdRef = useRef<Map<string, RemoteAudioNodes>>(new Map());
  const speakingIntervalRef = useRef<number | null>(null);
  const localSpeakingAnalyserRef = useRef<AnalyserNode | null>(null);
  const localSpeakingDataRef = useRef<Uint8Array | null>(null);
  const remoteSpeakingAnalyserByUserIdRef = useRef<Map<string, AnalyserNode>>(new Map());
  const remoteSpeakingDataByUserIdRef = useRef<Map<string, Uint8Array>>(new Map());
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const screenPeerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const screenSenderByUserIdRef = useRef<Map<string, RTCRtpSender>>(new Map());
  const screenAdaptationIntervalRef = useRef<number | null>(null);
  const remoteScreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const watchVideoRef = useRef<HTMLVideoElement | null>(null);
  const coWatchSuppressSyncRef = useRef(false);
  const highlightRecorderRef = useRef<MediaRecorder | null>(null);
  const highlightBufferRef = useRef<RollingClipChunk[]>([]);
  const highlightCaptureStreamRef = useRef<MediaStream | null>(null);
  const lastSentChannelTextRef = useRef('');

  const [auth, setAuth] = useState<AuthState | null>(() => loadAuthState());
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingAiReply, setStreamingAiReply] = useState<StreamingAiReply | null>(null);
  const [aiPromptByRequestId, setAiPromptByRequestId] = useState<Record<string, string>>({});
  const [aiRequestIdByMessageId, setAiRequestIdByMessageId] = useState<Record<string, string>>({});
  const [copiedAiMessageId, setCopiedAiMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [draft, setDraft] = useState('');
  const [systemMessage, setSystemMessage] = useState('Sign in to join chat.');
  const [error, setError] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<ModerationAuditLog[]>([]);
  const [aiSettingsByServer, setAiSettingsByServer] = useState<Record<string, ServerAiSettings>>({});
  const [aiSettingsDraftByServer, setAiSettingsDraftByServer] = useState<Record<string, ServerAiSettings>>({});

  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [onlineUserIdsByServer, setOnlineUserIdsByServer] = useState<Record<string, string[]>>({});
  const [typingByChannel, setTypingByChannel] = useState<
    Record<string, { userId: string; username: string }[]>
  >({});
  const [voiceParticipantsByChannel, setVoiceParticipantsByChannel] = useState<
    Record<string, VoiceParticipant[]>
  >({});
  const [voiceChannelId, setVoiceChannelId] = useState<string | null>(null);
  const [inputGain, setInputGain] = useState(100);
  const [selectedVoiceEffect, setSelectedVoiceEffect] = useState<VoiceEffectMode>('none');
  const [customSoundboardClip, setCustomSoundboardClip] = useState<{ name: string; data: AudioBuffer } | null>(null);
  const [activeEffectByUserId, setActiveEffectByUserId] = useState<Record<string, VoiceEffectMode>>({});
  const [outputVolumeByUserId, setOutputVolumeByUserId] = useState<Record<string, number>>({});
  const [peerStateByUserId, setPeerStateByUserId] = useState<Record<string, PeerConnectionHealth>>(
    {},
  );
  const [speakingByUserId, setSpeakingByUserId] = useState<Record<string, boolean>>({});
  const [voiceDashboard, setVoiceDashboard] = useState<{
    joinSuccessRate: number;
    medianSetupMs: number;
    disconnectCauses: Record<string, number>;
  }>({ joinSuccessRate: 0, medianSetupMs: 0, disconnectCauses: {} });
  const [activeScreenShare, setActiveScreenShare] = useState<{
    channelId: string;
    presenter: VoiceParticipant;
  } | null>(null);
  const [screenConsentState, setScreenConsentState] = useState<
    'idle' | 'prompting' | 'granted' | 'denied'
  >('idle');
  const [screenShareScopeWarning, setScreenShareScopeWarning] = useState<string | null>(null);
  const [remoteScreenStream, setRemoteScreenStream] = useState<MediaStream | null>(null);
  const [screenContentType, setScreenContentType] = useState<ScreenContentType>('mixed');
  const [screenNetworkQuality, setScreenNetworkQuality] = useState<'stable' | 'degraded'>('stable');
  const [coWatchState, setCoWatchState] = useState<CoWatchPlaybackState | null>(null);
  const [coWatchUrlInput, setCoWatchUrlInput] = useState('');
  const [coWatchLocalMedia, setCoWatchLocalMedia] = useState<{ fileName: string; objectUrl: string } | null>(null);
  const [coWatchAllowOthersControl, setCoWatchAllowOthersControl] = useState(false);
  const [highlightCaptureEnabled, setHighlightCaptureEnabled] = useState(false);
  const [highlightUploadOnSave, setHighlightUploadOnSave] = useState(false);
  const [highlightRecorderState, setHighlightRecorderState] = useState<HighlightRecorderState>('disabled');
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [serverNameInput, setServerNameInput] = useState('');
  const [channelNameInput, setChannelNameInput] = useState('');
  const [inviteUsernameInput, setInviteUsernameInput] = useState('');
  const [dmThreads, setDmThreads] = useState<DmThreadSummary[]>([]);
  const [activeDmThreadId, setActiveDmThreadId] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<DmMessage[]>([]);
  const [dmUsernameInput, setDmUsernameInput] = useState('');
  const [chatMode, setChatMode] = useState<'channel' | 'dm'>('channel');
  const [pendingAttachmentUploads, setPendingAttachmentUploads] = useState<PendingAttachmentUpload[]>([]);
  const [channelUnreadCounts, setChannelUnreadCounts] = useState<Record<string, number>>({});
  const [dmUnreadCounts, setDmUnreadCounts] = useState<Record<string, number>>({});
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] = useState(() =>
    loadDesktopNotificationsEnabled(),
  );
  const [spatialAudioEnabled, setSpatialAudioEnabled] = useState(() => loadSpatialAudioEnabled());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(
    () =>
      typeof window !== 'undefined' && 'Notification' in window
        ? Notification.permission
        : 'unsupported',
  );

  const wsUrl = useMemo(() => {
    if (!auth?.accessToken) {
      return null;
    }

    const base = apiBase.replace(/^http/, 'ws');
    return `${base}/?token=${encodeURIComponent(auth.accessToken)}`;
  }, [apiBase, auth?.accessToken]);

  const typingUsers = activeChannelId ? (typingByChannel[activeChannelId] ?? []) : [];
  const voiceParticipants = activeChannelId
    ? (voiceParticipantsByChannel[activeChannelId] ?? [])
    : [];

  useEffect(() => {
    const senders = Array.from(screenSenderByUserIdRef.current.values());
    for (const sender of senders) {
      void applyScreenEncodingPreset(sender, screenContentType, screenNetworkQuality).catch(() => {
        // ignore sender parameter failures for unsupported browsers
      });
    }
  }, [screenContentType, screenNetworkQuality]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<(ChatMessage | DmMessage)[]>([]);
  const [searchNextCursor, setSearchNextCursor] = useState<string | null>(null);
  const [searchCursorTrail, setSearchCursorTrail] = useState<(string | null)[]>([null]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const SEARCH_PAGE_SIZE = 20;

  const visibleMessages = chatMode === 'dm' ? dmMessages : messages;
  const showingSearchResults = searchQuery.trim().length > 0;
  const displayedMessages = showingSearchResults ? searchResults : visibleMessages;
  const shouldShowStreamingAiReply = Boolean(
    !showingSearchResults &&
      chatMode === 'channel' &&
      activeChannelId &&
      streamingAiReply &&
      streamingAiReply.channelId === activeChannelId,
  );
  const currentMember = members.find((member) => member.userId === auth?.user.id) ?? null;
  const isServerOwner = currentMember?.role === 'owner';
  const canControlCoWatch = Boolean(
    auth && (!coWatchState || coWatchState.hostUserId === auth.user.id || coWatchState.controllers.includes(auth.user.id)),
  );
  const totalChannelUnread = Object.values(channelUnreadCounts).reduce(
    (sum, value) => sum + value,
    0,
  );
  const totalDmUnread = Object.values(dmUnreadCounts).reduce((sum, value) => sum + value, 0);
  const activeServer = servers.find((server) => server.id === activeServerId) ?? null;
  const activeServerAiSettings = activeServerId ? aiSettingsByServer[activeServerId] ?? null : null;
  const activeServerAiDraft = activeServerId
    ? aiSettingsDraftByServer[activeServerId] ?? activeServerAiSettings
    : null;

  useEffect(() => {
    activeChannelRef.current = activeChannelId;
  }, [activeChannelId]);

  useEffect(() => {
    if (!activeChannelId) {
      return;
    }

    coWatchSend({ type: 'watch:state', payload: { channelId: activeChannelId } });
  }, [activeChannelId]);

  useEffect(() => {
    activeDmThreadRef.current = activeDmThreadId;
  }, [activeDmThreadId]);

  useEffect(() => {
    chatModeRef.current = chatMode;
  }, [chatMode]);

  useEffect(() => {
    desktopNotificationsEnabledRef.current = desktopNotificationsEnabled;
    saveDesktopNotificationsEnabled(desktopNotificationsEnabled);
  }, [desktopNotificationsEnabled]);

  const spatialAudioAvailable = useMemo(() => {
    const AudioContextCtor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return !!AudioContextCtor;
  }, []);

  useEffect(() => {
    if (!spatialAudioAvailable && spatialAudioEnabled) {
      setSpatialAudioEnabled(false);
      return;
    }

    saveSpatialAudioEnabled(spatialAudioEnabled);
  }, [spatialAudioAvailable, spatialAudioEnabled]);

  useEffect(() => {
    notificationPermissionRef.current = notificationPermission;
  }, [notificationPermission]);

  useEffect(() => {
    if (!localGainNodeRef.current) {
      return;
    }

    localGainNodeRef.current.gain.value = inputGain / 100;
  }, [inputGain]);

  useEffect(() => {
    for (const [userId, audio] of remoteAudioByUserIdRef.current.entries()) {
      const gain = (outputVolumeByUserId[userId] ?? 100) / 100;
      const remoteNodes = remoteAudioNodesByUserIdRef.current.get(userId);
      if (remoteNodes?.gain) {
        remoteNodes.gain.gain.value = gain;
      } else {
        audio.volume = gain;
      }
    }
  }, [outputVolumeByUserId]);

  const remoteVoiceParticipants = useMemo(() => {
    if (!voiceChannelId) {
      return [];
    }

    return (voiceParticipantsByChannel[voiceChannelId] ?? [])
      .filter((participant) => participant.userId !== auth?.user.id)
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }, [auth?.user.id, voiceChannelId, voiceParticipantsByChannel]);

  useEffect(() => {
    if (!spatialAudioEnabled || !remoteAudioContextRef.current) {
      return;
    }

    const now = remoteAudioContextRef.current.currentTime;
    for (const [index, participant] of remoteVoiceParticipants.entries()) {
      const nodes = remoteAudioNodesByUserIdRef.current.get(participant.userId);
      if (!nodes?.spatial || !nodes.panner) {
        continue;
      }

      const position = getSpatialPositionFromIndex(index, remoteVoiceParticipants.length);
      if ('positionX' in nodes.panner && nodes.panner.positionX) {
        nodes.panner.positionX.setTargetAtTime(position.x, now, 0.2);
        nodes.panner.positionY.setTargetAtTime(position.y, now, 0.2);
        nodes.panner.positionZ.setTargetAtTime(position.z, now, 0.2);
      } else {
        nodes.panner.setPosition(position.x, position.y, position.z);
      }
    }
  }, [remoteVoiceParticipants, spatialAudioEnabled]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
    }
    heartbeatIntervalRef.current = window.setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(JSON.stringify({ type: 'ping', payload: {} }));
      if (heartbeatTimeoutRef.current) {
        window.clearTimeout(heartbeatTimeoutRef.current);
      }

      heartbeatTimeoutRef.current = window.setTimeout(() => {
        addDisconnectCause('heartbeat_timeout');
        socket.close();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (heartbeatIntervalRef.current) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (heartbeatTimeoutRef.current) {
        window.clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
    };
  }, [connectionState]);

  useEffect(() => {
    const AudioContextCtor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    if (!remoteAudioContextRef.current) {
      remoteAudioContextRef.current = new AudioContextCtor();
    }

    if (speakingIntervalRef.current) {
      window.clearInterval(speakingIntervalRef.current);
    }

    speakingIntervalRef.current = window.setInterval(() => {
      const next: Record<string, boolean> = {};

      const localAnalyser = localSpeakingAnalyserRef.current;
      const localData = localSpeakingDataRef.current;
      if (localAnalyser && localData && auth?.user.id) {
        localAnalyser.getByteTimeDomainData(localData as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < localData.length; i += 1) {
          const centered = localData[i] - 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / localData.length);
        next[auth.user.id] = rms > 8;
      }

      for (const [userId, analyser] of remoteSpeakingAnalyserByUserIdRef.current.entries()) {
        const data = remoteSpeakingDataByUserIdRef.current.get(userId);
        if (!data) {
          continue;
        }
        analyser.getByteTimeDomainData(data as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = data[i] - 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        next[userId] = rms > 8;
      }

      setSpeakingByUserId(next);
    }, 220);

    return () => {
      if (speakingIntervalRef.current) {
        window.clearInterval(speakingIntervalRef.current);
        speakingIntervalRef.current = null;
      }
    };
  }, [auth?.user.id]);

  function refreshVoiceDashboard() {
    const metrics = voiceMetricsRef.current;
    const joinSuccessRate =
      metrics.joinAttempts > 0 ? (metrics.joinSuccesses / metrics.joinAttempts) * 100 : 0;
    const sorted = [...metrics.setupDurationsMs].sort((a, b) => a - b);
    const medianSetupMs =
      sorted.length === 0
        ? 0
        : sorted.length % 2 === 1
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    setVoiceDashboard({
      joinSuccessRate,
      medianSetupMs,
      disconnectCauses: { ...metrics.disconnectCauses },
    });
  }

  function addDisconnectCause(cause: string) {
    voiceMetricsRef.current.disconnectCauses[cause] =
      (voiceMetricsRef.current.disconnectCauses[cause] ?? 0) + 1;
    refreshVoiceDashboard();
  }

  function updatePeerState(userId: string, state: PeerConnectionHealth) {
    setPeerStateByUserId((prev) => ({ ...prev, [userId]: state }));
  }

  function disposeAudioForUser(userId: string) {
    const audio = remoteAudioByUserIdRef.current.get(userId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      remoteAudioByUserIdRef.current.delete(userId);
    }
    const nodes = remoteAudioNodesByUserIdRef.current.get(userId);
    if (nodes) {
      disposeRemoteAudioNodes(nodes);
      remoteAudioNodesByUserIdRef.current.delete(userId);
    }
    remoteSpeakingAnalyserByUserIdRef.current.delete(userId);
    remoteSpeakingDataByUserIdRef.current.delete(userId);
    setSpeakingByUserId((prev) => {
      if (!(userId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }

  function closePeerConnection(userId: string) {
    const peerConnection = peerConnectionsRef.current.get(userId);
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
      peerConnectionsRef.current.delete(userId);
    }
    peerChannelByUserIdRef.current.delete(userId);
    peerSetupStartRef.current.delete(userId);
    setPeerStateByUserId((prev) => {
      if (!(userId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[userId];
      return next;
    });

    disposeAudioForUser(userId);
  }

  function closeScreenPeerConnection(userId: string) {
    const peerConnection = screenPeerConnectionsRef.current.get(userId);
    if (!peerConnection) {
      return;
    }

    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.close();
    screenPeerConnectionsRef.current.delete(userId);
    screenSenderByUserIdRef.current.delete(userId);
  }

  function resolveScreenPreset(contentType: ScreenContentType, quality: 'stable' | 'degraded') {
    const preset = SCREEN_PRESETS[contentType];
    if (quality === 'stable') {
      return preset;
    }

    return {
      maxBitrateBps: Math.max(300_000, Math.round(preset.maxBitrateBps * 0.65)),
      maxFramerate: Math.max(5, Math.round(preset.maxFramerate * 0.7)),
    } satisfies ScreenEncodingPreset;
  }

  async function applyScreenEncodingPreset(
    sender: RTCRtpSender,
    contentType: ScreenContentType,
    quality: 'stable' | 'degraded',
  ) {
    const parameters = sender.getParameters();
    const encodings =
      parameters.encodings && parameters.encodings.length > 0 ? parameters.encodings : [{}];
    const preset = resolveScreenPreset(contentType, quality);
    parameters.encodings = encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: preset.maxBitrateBps,
      maxFramerate: preset.maxFramerate,
    }));
    await sender.setParameters(parameters);
  }

  function monitorScreenNetworkAndAdapt() {
    if (screenAdaptationIntervalRef.current !== null) {
      window.clearInterval(screenAdaptationIntervalRef.current);
      screenAdaptationIntervalRef.current = null;
    }

    screenAdaptationIntervalRef.current = window.setInterval(() => {
      const senders = Array.from(screenSenderByUserIdRef.current.values());
      if (senders.length === 0) {
        return;
      }

      let degraded = false;
      for (const sender of senders) {
        const transport = sender.transport;
        if (!transport) {
          continue;
        }
        const candidatePair = (
          transport.iceTransport as
            | (RTCIceTransport & {
                getSelectedCandidatePair?: () => {
                  currentRoundTripTime?: number;
                  packetsSent?: number;
                  packetsDiscardedOnSend?: number;
                } | null;
              })
            | null
        )?.getSelectedCandidatePair?.();
        if (!candidatePair) {
          continue;
        }

        const candidatePairStats = candidatePair as RTCIceCandidatePair & {
          currentRoundTripTime?: number;
          packetsSent?: number;
          packetsDiscardedOnSend?: number;
        };
        const currentRtt = candidatePairStats.currentRoundTripTime ?? 0;
        const packetsSent = candidatePairStats.packetsSent ?? 0;
        const packetLoss =
          packetsSent > 0 ? (candidatePairStats.packetsDiscardedOnSend ?? 0) / packetsSent : 0;
        if (currentRtt > 0.25 || packetLoss > 0.03) {
          degraded = true;
          break;
        }
      }

      const nextQuality = degraded ? 'degraded' : 'stable';
      setScreenNetworkQuality(nextQuality);
      for (const sender of senders) {
        void applyScreenEncodingPreset(sender, screenContentType, nextQuality).catch(() => {
          // ignore sender parameter failures for unsupported browsers
        });
      }
    }, SCREEN_ADAPT_INTERVAL_MS);
  }

  function stopScreenAdaptation() {
    if (screenAdaptationIntervalRef.current !== null) {
      window.clearInterval(screenAdaptationIntervalRef.current);
      screenAdaptationIntervalRef.current = null;
    }
    screenSenderByUserIdRef.current.clear();
    setScreenNetworkQuality('stable');
  }

  function stopAllScreenShare() {
    for (const userId of Array.from(screenPeerConnectionsRef.current.keys())) {
      closeScreenPeerConnection(userId);
    }

    const localScreenStream = localScreenStreamRef.current;
    if (localScreenStream) {
      for (const track of localScreenStream.getTracks()) {
        track.stop();
      }
      localScreenStreamRef.current = null;
    }

    setRemoteScreenStream(null);
    stopScreenAdaptation();
  }

  async function createScreenPeerConnection(
    targetUserId: string,
    channelId: string,
    createOffer: boolean,
    streamType: StreamType,
  ) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return null;
    }

    if (screenPeerConnectionsRef.current.has(targetUserId)) {
      return screenPeerConnectionsRef.current.get(targetUserId) ?? null;
    }

    const peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: 'screen:signal',
          payload: {
            channelId,
            targetUserId,
            streamType,
            candidate: event.candidate.toJSON(),
          },
        }),
      );
    };

    peerConnection.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) {
        return;
      }
      setRemoteScreenStream(stream);
    };

    if (createOffer) {
      const stream = localScreenStreamRef.current;
      if (!stream) {
        return null;
      }

      for (const track of stream.getTracks()) {
        const sender = peerConnection.addTrack(track, stream);
        if (track.kind === 'video') {
          screenSenderByUserIdRef.current.set(targetUserId, sender);
          void applyScreenEncodingPreset(sender, screenContentType, screenNetworkQuality).catch(
            () => {
              // ignore sender parameter failures for unsupported browsers
            },
          );
        }
      }
    }

    screenPeerConnectionsRef.current.set(targetUserId, peerConnection);

    if (createOffer) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.send(
        JSON.stringify({
          type: 'screen:signal',
          payload: {
            channelId,
            targetUserId,
            streamType,
            description: offer,
          },
        }),
      );
    }

    return peerConnection;
  }

  function stopAllVoice() {
    stopAllScreenShare();
    setScreenShareScopeWarning(null);
    setScreenConsentState('idle');
    for (const userId of Array.from(peerConnectionsRef.current.keys())) {
      closePeerConnection(userId);
    }

    const localStream = localVoiceStreamRef.current;
    if (localStream) {
      for (const track of localStream.getTracks()) {
        track.stop();
      }
      localVoiceStreamRef.current = null;
    }

    const processedLocalStream = processedLocalVoiceStreamRef.current;
    if (processedLocalStream) {
      for (const track of processedLocalStream.getTracks()) {
        track.stop();
      }
      processedLocalVoiceStreamRef.current = null;
    }

    localGainNodeRef.current = null;
    soundboardLimiterNodeRef.current = null;
    localSpeakingAnalyserRef.current = null;
    localSpeakingDataRef.current = null;
    void localAudioContextRef.current?.close();
    localAudioContextRef.current = null;
  }


  function connectVoiceEffectChain(context: AudioContext, source: AudioNode, effect: VoiceEffectMode) {
    if (effect === 'robot') {
      const shaper = context.createWaveShaper();
      shaper.curve = new Float32Array(Array.from({ length: 256 }, (_, i) => Math.tanh(((i - 128) / 96) * 2)));
      source.connect(shaper);
      return shaper as AudioNode;
    }

    if (effect === 'megaphone') {
      const bandPass = context.createBiquadFilter();
      bandPass.type = 'bandpass';
      bandPass.frequency.value = 1400;
      source.connect(bandPass);
      return bandPass as AudioNode;
    }

    if (effect === 'pitch-shift') {
      const highPass = context.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.value = 260;
      source.connect(highPass);
      return highPass as AudioNode;
    }

    return source;
  }

  function triggerSoundboardSignal(clipId: string) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeChannelId) return;
    socket.send(JSON.stringify({ type: 'soundboard:trigger', payload: { channelId: activeChannelId, clipId } }));
  }

  function playBuiltInClip(clipId: string) {
    const context = localAudioContextRef.current;
    const limiter = soundboardLimiterNodeRef.current;
    const clip = SOUNDBOARD_CLIPS.find((entry) => entry.id === clipId);
    if (!context || !limiter || !clip) return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = clip.frequency;
    gain.gain.value = 0.0001;
    oscillator.connect(gain);
    gain.connect(limiter);
    const now = context.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.45, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + clip.durationMs / 1000);
    oscillator.start(now);
    oscillator.stop(now + clip.durationMs / 1000 + 0.05);
    triggerSoundboardSignal(clip.id);
  }

  async function handleCustomSoundUpload(file: File | null) {
    if (!file) {
      setCustomSoundboardClip(null);
      return;
    }

    const context = localAudioContextRef.current;
    if (!context) {
      setError('Join voice before loading a custom sound clip.');
      return;
    }

    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    setCustomSoundboardClip({ name: file.name, data: decoded });
  }

  function playCustomClip() {
    const context = localAudioContextRef.current;
    const limiter = soundboardLimiterNodeRef.current;
    if (!context || !limiter || !customSoundboardClip) return;

    const source = context.createBufferSource();
    source.buffer = customSoundboardClip.data;
    source.connect(limiter);
    source.start();
    triggerSoundboardSignal('custom-upload');
  }

  async function ensureLocalVoiceStream() {
    if (processedLocalVoiceStreamRef.current) {
      return processedLocalVoiceStreamRef.current;
    }

    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
      video: false,
    });

    localVoiceStreamRef.current = rawStream;
    const AudioContextCtor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      processedLocalVoiceStreamRef.current = rawStream;
      return rawStream;
    }

    const context = new AudioContextCtor();
    localAudioContextRef.current = context;
    const source = context.createMediaStreamSource(rawStream);
    const gainNode = context.createGain();
    gainNode.gain.value = inputGain / 100;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const effectedSource = connectVoiceEffectChain(context, source, selectedVoiceEffect);
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.ratio.value = 10;

    effectedSource.connect(gainNode);
    gainNode.connect(analyser);

    const destination = context.createMediaStreamDestination();
    gainNode.connect(destination);
    limiter.connect(destination);

    localGainNodeRef.current = gainNode;
    soundboardLimiterNodeRef.current = limiter;
    localSpeakingAnalyserRef.current = analyser;
    localSpeakingDataRef.current = new Uint8Array(analyser.fftSize);
    processedLocalVoiceStreamRef.current = destination.stream;

    return destination.stream;
  }

  function handlePeerConnectionFailure(targetUserId: string, channelId: string) {
    const peerConnection = peerConnectionsRef.current.get(targetUserId);
    const socket = socketRef.current;
    if (!peerConnection || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    updatePeerState(targetUserId, 'restarting');
    void peerConnection.restartIce();
    void peerConnection
      .createOffer({ iceRestart: true })
      .then(async (offer) => {
        await peerConnection.setLocalDescription(offer);
        socket.send(
          JSON.stringify({
            type: 'voice:signal',
            payload: {
              channelId,
              targetUserId,
              streamType: 'audio',
              description: offer,
              iceRestart: true,
            },
          }),
        );
      })
      .catch(() => {
        updatePeerState(targetUserId, 'failed');
      });
  }

  async function createPeerConnection(
    targetUserId: string,
    channelId: string,
    createOffer: boolean,
  ) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !auth) {
      return null;
    }

    if (peerConnectionsRef.current.has(targetUserId)) {
      return peerConnectionsRef.current.get(targetUserId) ?? null;
    }

    const stream = await ensureLocalVoiceStream();
    const peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    updatePeerState(targetUserId, 'connecting');
    peerChannelByUserIdRef.current.set(targetUserId, channelId);
    peerSetupStartRef.current.set(targetUserId, Date.now());

    for (const track of stream.getTracks()) {
      peerConnection.addTrack(track, stream);
    }

    peerConnection.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (!remoteStream) {
        return;
      }

      let audio = remoteAudioByUserIdRef.current.get(targetUserId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        remoteAudioByUserIdRef.current.set(targetUserId, audio);
      }

      audio.srcObject = remoteStream;
      const hasSpatialSupport = spatialAudioEnabled && remoteAudioContextRef.current;
      const existingNodes = remoteAudioNodesByUserIdRef.current.get(targetUserId);
      if (existingNodes) {
        disposeRemoteAudioNodes(existingNodes);
        remoteAudioNodesByUserIdRef.current.delete(targetUserId);
      }

      if (hasSpatialSupport && remoteAudioContextRef.current) {
        const context = remoteAudioContextRef.current;
        const source = context.createMediaStreamSource(remoteStream);
        const panner = context.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1;
        panner.maxDistance = 15;
        panner.rolloffFactor = 1;
        const gain = context.createGain();
        gain.gain.value = (outputVolumeByUserId[targetUserId] ?? 100) / 100;
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;

        source.connect(panner);
        panner.connect(gain);
        gain.connect(analyser);
        gain.connect(context.destination);
        const participantIndex = remoteVoiceParticipants.findIndex(
          (participant) => participant.userId === targetUserId,
        );
        const position = getSpatialPositionFromIndex(
          participantIndex >= 0 ? participantIndex : 0,
          Math.max(remoteVoiceParticipants.length, 1),
        );
        if ('positionX' in panner && panner.positionX) {
          panner.positionX.value = position.x;
          panner.positionY.value = position.y;
          panner.positionZ.value = position.z;
        } else {
          panner.setPosition(position.x, position.y, position.z);
        }
        audio.volume = 1;
        audio.muted = true;

        remoteAudioNodesByUserIdRef.current.set(targetUserId, {
          stream: remoteStream,
          source,
          analyser,
          spatial: true,
          panner,
          gain,
        });
        remoteSpeakingAnalyserByUserIdRef.current.set(targetUserId, analyser);
        remoteSpeakingDataByUserIdRef.current.set(targetUserId, new Uint8Array(analyser.fftSize));
      } else {
        audio.muted = false;
        audio.volume = (outputVolumeByUserId[targetUserId] ?? 100) / 100;

        if (remoteAudioContextRef.current) {
          const source = remoteAudioContextRef.current.createMediaStreamSource(remoteStream);
          const analyser = remoteAudioContextRef.current.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          remoteAudioNodesByUserIdRef.current.set(targetUserId, {
            stream: remoteStream,
            source,
            analyser,
            spatial: false,
            panner: null,
            gain: null,
          });
          remoteSpeakingAnalyserByUserIdRef.current.set(targetUserId, analyser);
          remoteSpeakingDataByUserIdRef.current.set(targetUserId, new Uint8Array(analyser.fftSize));
        }
      }

      void audio.play().catch(() => {
        setError('Click anywhere on the page once to allow voice playback.');
      });
    };

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: 'voice:signal',
          payload: {
            channelId,
            targetUserId,
            streamType: 'audio',
            candidate: event.candidate.toJSON(),
          },
        }),
      );
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connected') {
        updatePeerState(targetUserId, 'connected');
        const startedAt = peerSetupStartRef.current.get(targetUserId);
        if (startedAt) {
          voiceMetricsRef.current.setupDurationsMs.push(Date.now() - startedAt);
          peerSetupStartRef.current.delete(targetUserId);
          refreshVoiceDashboard();
        }
      }

      if (peerConnection.connectionState === 'failed') {
        updatePeerState(targetUserId, 'failed');
        handlePeerConnectionFailure(targetUserId, channelId);
      }
    };

    peerConnectionsRef.current.set(targetUserId, peerConnection);

    if (createOffer) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.send(
        JSON.stringify({
          type: 'voice:signal',
          payload: {
            channelId,
            targetUserId,
            streamType: 'audio',
            description: offer,
            iceRestart: false,
          },
        }),
      );
    }

    return peerConnection;
  }

  useEffect(() => {
    for (const [userId, audio] of remoteAudioByUserIdRef.current.entries()) {
      const stream = audio.srcObject;
      if (!(stream instanceof MediaStream)) {
        continue;
      }

      const nodes = remoteAudioNodesByUserIdRef.current.get(userId);
      if (!nodes || nodes.stream !== stream || nodes.spatial !== spatialAudioEnabled) {
        const event = { streams: [stream] } as unknown as RTCTrackEvent;
        const pc = peerConnectionsRef.current.get(userId);
        if (pc?.ontrack) {
          pc.ontrack(event);
        }
      }
    }
  }, [spatialAudioEnabled]);

  function updateAuth(next: AuthState | null) {
    setAuth(next);
    saveAuthState(next);
  }

  function sendTypingStop(channelId?: string) {
    const socket = socketRef.current;
    const targetChannelId = channelId ?? activeChannelId;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !targetChannelId ||
      !isTypingRef.current
    ) {
      return;
    }

    socket.send(JSON.stringify({ type: 'typing:stop', payload: { channelId: targetChannelId } }));
    isTypingRef.current = false;

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }

  function queueTypingStop() {
    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = window.setTimeout(() => {
      sendTypingStop();
    }, TYPING_STOP_DELAY_MS);
  }

  async function authedFetch(path: string, init?: RequestInit) {
    if (!auth) {
      throw new Error('Not authenticated.');
    }

    const headers = new Headers(init?.headers ?? {});
    headers.set('Authorization', `Bearer ${auth.accessToken}`);
    return fetch(`${apiBase}${path}`, { ...init, headers });
  }

  async function loadServers() {
    const res = await authedFetch('/servers');
    if (!res.ok) {
      throw new Error('Unable to load servers.');
    }

    const data = (await res.json()) as { servers: ServerSummary[] };
    setServers(data.servers);
    if (!activeServerId && data.servers.length > 0) {
      setActiveServerId(data.servers[0].id);
    }
  }

  async function loadChannels(serverId: string) {
    const res = await authedFetch(`/servers/${serverId}/channels`);
    if (!res.ok) {
      throw new Error('Unable to load channels.');
    }

    const data = (await res.json()) as { channels: ChannelSummary[] };
    setChannels(data.channels);
    if (!data.channels.some((channel) => channel.id === activeChannelId)) {
      setActiveChannelId(data.channels[0]?.id ?? null);
    }
  }

  async function loadMembers(serverId: string) {
    const res = await authedFetch(`/servers/${serverId}/members`);
    if (!res.ok) {
      throw new Error('Unable to load members.');
    }

    const data = (await res.json()) as { members: ServerMember[] };
    setMembers(data.members);
  }

  async function loadAuditLogs(serverId: string) {
    const res = await authedFetch(`/servers/${serverId}/audit-logs?limit=20`);
    if (!res.ok) {
      setAuditLogs([]);
      return;
    }

    const data = (await res.json()) as { logs: ModerationAuditLog[] };
    setAuditLogs(data.logs);
  }

  async function loadServerAiSettings(serverId: string) {
    const res = await authedFetch(`/servers/${serverId}/ai-settings`);
    if (!res.ok) {
      return;
    }

    const data = (await res.json()) as { settings: ServerAiSettings };
    setAiSettingsByServer((current) => ({ ...current, [serverId]: data.settings }));
    setAiSettingsDraftByServer((current) => ({ ...current, [serverId]: data.settings }));
  }

  function updateActiveServerAiDraft(patch: Partial<ServerAiSettings>) {
    if (!activeServerId || !activeServerAiDraft) {
      return;
    }

    setAiSettingsDraftByServer((current) => ({
      ...current,
      [activeServerId]: { ...activeServerAiDraft, ...patch },
    }));
  }

  async function saveActiveServerAiSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeServerId || !activeServerAiDraft || !isServerOwner) {
      return;
    }

    const res = await authedFetch(`/servers/${activeServerId}/ai-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: activeServerAiDraft.enabled,
        model: activeServerAiDraft.model,
        systemPrompt: activeServerAiDraft.systemPrompt,
        temperature: activeServerAiDraft.temperature,
        maxTokensPerReply: activeServerAiDraft.maxTokensPerReply,
        invocationPolicy: activeServerAiDraft.invocationPolicy,
      }),
    });

    if (!res.ok) {
      setError('Unable to save AI settings.');
      return;
    }

    const data = (await res.json()) as { settings: ServerAiSettings };
    setAiSettingsByServer((current) => ({ ...current, [activeServerId]: data.settings }));
    setAiSettingsDraftByServer((current) => ({ ...current, [activeServerId]: data.settings }));
  }

  async function loadDmThreads() {
    const res = await authedFetch('/dm/threads');
    if (!res.ok) {
      throw new Error('Unable to load DM threads.');
    }

    const data = (await res.json()) as { threads: DmThreadSummary[] };
    setDmThreads(data.threads);
    if (!activeDmThreadId && data.threads.length > 0) {
      setActiveDmThreadId(data.threads[0].id);
    }
  }

  async function loadUnreadSummary() {
    const res = await authedFetch('/unread/summary');
    if (!res.ok) {
      throw new Error('Unable to load unread summary.');
    }

    const data = (await res.json()) as {
      summary: {
        channels: Record<string, number>;
        dmThreads: Record<string, number>;
      };
    };
    setChannelUnreadCounts(data.summary.channels);
    setDmUnreadCounts(data.summary.dmThreads);
  }

  async function markActiveChannelRead(channelId: string) {
    const res = await authedFetch(`/channels/${channelId}/read`, { method: 'POST' });
    if (!res.ok) {
      throw new Error('Unable to update channel read marker.');
    }
  }

  async function markActiveDmThreadRead(threadId: string) {
    const res = await authedFetch(`/dm/threads/${threadId}/read`, { method: 'POST' });
    if (!res.ok) {
      throw new Error('Unable to update DM read marker.');
    }
  }

  useEffect(() => {
    if (!auth) {
      setConnectionState('closed');
      setMessages([]);
      setStreamingAiReply(null);
      setAiPromptByRequestId({});
      setAiRequestIdByMessageId({});
      setServers([]);
      setChannels([]);
      setMembers([]);
      setOnlineUserIdsByServer({});
      setTypingByChannel({});
      setVoiceParticipantsByChannel({});
      setVoiceChannelId(null);
      setActiveServerId(null);
      setActiveChannelId(null);
      setSystemMessage('Sign in to join chat.');
      setDmThreads([]);
      setActiveDmThreadId(null);
      setDmMessages([]);
      setChatMode('channel');
      setAuditLogs([]);
      setAiSettingsByServer({});
      setAiSettingsDraftByServer({});
      setPendingAttachmentUploads([]);
      setChannelUnreadCounts({});
      setDmUnreadCounts({});
      setSearchQuery('');
      setSearchResults([]);
      setSearchNextCursor(null);
      setSearchCursorTrail([null]);
      setSearchError(null);
      return;
    }

    void Promise.all([loadServers(), loadDmThreads(), loadUnreadSummary()]).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Unable to load servers.');
    });
  }, [auth]);

  useEffect(() => {
    if (!auth || !activeServerId) {
      setChannels([]);
      setMembers([]);
      setActiveChannelId(null);
      return;
    }

    void Promise.all([
      loadChannels(activeServerId),
      loadMembers(activeServerId),
      loadAuditLogs(activeServerId),
      loadServerAiSettings(activeServerId),
    ]).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Unable to load server data.');
    });
  }, [auth?.user.id, activeServerId]);

  useEffect(() => {
    if (!wsUrl || !auth) {
      return;
    }
    shouldReconnectRef.current = true;

    const connectSocket = () => {
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;
      currentSocketRef.current = socket;
      setConnectionState('connecting');

      socket.addEventListener('open', () => {
        reconnectAttemptRef.current = 0;
        setConnectionState('open');
        setError(null);
        console.info('[ws] connected');
        if (activeServerId) {
          socket.send(
            JSON.stringify({ type: 'presence:join-server', payload: { serverId: activeServerId } }),
          );
        }
      });

      socket.addEventListener('message', (event) => {
        let parsed: ServerEvent;

        try {
          parsed = JSON.parse(String(event.data)) as ServerEvent;
        } catch {
          setError('Received an invalid event from server.');
          console.error('[ws] invalid_event_json');
          return;
        }

        if (parsed.type === 'pong') {
          if (heartbeatTimeoutRef.current) {
            window.clearTimeout(heartbeatTimeoutRef.current);
            heartbeatTimeoutRef.current = null;
          }
          return;
        }

        if (parsed.type === 'chat:history') {
          if (parsed.payload.channelId === activeChannelRef.current) {
            setMessages(parsed.payload.messages);
          }
        }

        if (parsed.type === 'chat:message') {
          if (parsed.payload.message.channelId === activeChannelRef.current) {
            setMessages((prev) => [...prev, parsed.payload.message]);
          }
        }

        if (parsed.type === 'chat:message-edited') {
          if (parsed.payload.channelId === activeChannelRef.current) {
            setMessages((prev) =>
              prev.map((message) =>
                message.id === parsed.payload.messageId
                  ? { ...message, text: parsed.payload.text, editedAt: parsed.payload.editedAt }
                  : message,
              ),
            );
          }
        }

        if (parsed.type === 'chat:bot-pending') {
          if (parsed.payload.requestedByUserId === auth.user.id && lastSentChannelTextRef.current.trim()) {
            setAiPromptByRequestId((prev) => ({
              ...prev,
              [parsed.payload.requestId]: lastSentChannelTextRef.current,
            }));
          }
        }

        if (parsed.type === 'ai:reply-start') {
          if (parsed.payload.channelId === activeChannelRef.current) {
            setStreamingAiReply({
              requestId: parsed.payload.requestId,
              channelId: parsed.payload.channelId,
              botDisplayName: parsed.payload.botDisplayName,
              requestedByUserId: parsed.payload.requestedByUserId,
              text: '',
            });
          }
        }

        if (parsed.type === 'ai:reply-chunk') {
          if (parsed.payload.channelId === activeChannelRef.current) {
            setStreamingAiReply((prev) => {
              if (!prev || prev.requestId !== parsed.payload.requestId) {
                return {
                  requestId: parsed.payload.requestId,
                  channelId: parsed.payload.channelId,
                  botDisplayName: 'assistant',
                  requestedByUserId: auth.user.id,
                  text: parsed.payload.chunk,
                };
              }

              return { ...prev, text: `${prev.text}${parsed.payload.chunk}` };
            });
          }
        }

        if (parsed.type === 'ai:reply-complete') {
          setAiRequestIdByMessageId((prev) => ({
            ...prev,
            [parsed.payload.message.id]: parsed.payload.requestId,
          }));
          if (parsed.payload.channelId === activeChannelRef.current) {
            setStreamingAiReply((prev) =>
              prev && prev.requestId === parsed.payload.requestId ? null : prev,
            );
          }
        }

        if (parsed.type === 'ai:reply-error') {
          if (parsed.payload.channelId === activeChannelRef.current) {
            setStreamingAiReply((prev) =>
              prev && prev.requestId === parsed.payload.requestId ? null : prev,
            );
            setError(parsed.payload.message);
          }
        }

        if (parsed.type === 'dm:history') {
          if (parsed.payload.threadId === activeDmThreadRef.current) {
            setDmMessages(parsed.payload.messages);
          }
        }

        if (parsed.type === 'dm:message') {
          setDmThreads((prev) => {
            const hasThread = prev.some((thread) => thread.id === parsed.payload.message.threadId);
            if (!hasThread) {
              return prev;
            }

            const next = prev.map((thread) =>
              thread.id === parsed.payload.message.threadId
                ? { ...thread, lastMessageAt: parsed.payload.message.createdAt }
                : thread,
            );
            next.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
            return next;
          });

          if (parsed.payload.message.threadId === activeDmThreadRef.current) {
            setDmMessages((prev) => [...prev, parsed.payload.message]);
          }
        }

        if (parsed.type === 'presence:sync') {
          setOnlineUserIdsByServer((prev) => ({
            ...prev,
            [parsed.payload.serverId]: parsed.payload.onlineUserIds,
          }));
        }

        if (parsed.type === 'presence:user-online') {
          setOnlineUserIdsByServer((prev) => {
            const existing = new Set(prev[parsed.payload.serverId] ?? []);
            existing.add(parsed.payload.userId);
            return { ...prev, [parsed.payload.serverId]: Array.from(existing) };
          });
        }

        if (parsed.type === 'presence:user-offline') {
          setOnlineUserIdsByServer((prev) => ({
            ...prev,
            [parsed.payload.serverId]: (prev[parsed.payload.serverId] ?? []).filter(
              (userId) => userId !== parsed.payload.userId,
            ),
          }));
        }

        if (parsed.type === 'typing:start') {
          if (parsed.payload.userId === auth.user.id) {
            return;
          }

          setTypingByChannel((prev) => {
            const current = prev[parsed.payload.channelId] ?? [];
            if (current.some((item) => item.userId === parsed.payload.userId)) {
              return prev;
            }

            return {
              ...prev,
              [parsed.payload.channelId]: [
                ...current,
                { userId: parsed.payload.userId, username: parsed.payload.username },
              ],
            };
          });
        }

        if (parsed.type === 'typing:stop') {
          setTypingByChannel((prev) => ({
            ...prev,
            [parsed.payload.channelId]: (prev[parsed.payload.channelId] ?? []).filter(
              (item) => item.userId !== parsed.payload.userId,
            ),
          }));
        }

        if (parsed.type === 'notification:channel-message') {
          if (parsed.payload.senderUserId !== auth.user.id) {
            const isActiveView =
              chatModeRef.current === 'channel' &&
              activeChannelRef.current === parsed.payload.channelId;

            if (!isActiveView) {
              setChannelUnreadCounts((prev) => ({
                ...prev,
                [parsed.payload.channelId]: (prev[parsed.payload.channelId] ?? 0) + 1,
              }));
            }

            if (
              desktopNotificationsEnabledRef.current &&
              notificationPermissionRef.current === 'granted' &&
              containsMentionForUser(parsed.payload.text, auth.user.username)
            ) {
              new Notification(
                `#${channels.find((item) => item.id === parsed.payload.channelId)?.name ?? 'channel'}`,
                {
                  body: `${parsed.payload.senderUsername}: ${previewText(parsed.payload.text)}`,
                },
              );
            }
          }
        }

        if (parsed.type === 'notification:dm-message') {
          if (parsed.payload.senderUserId !== auth.user.id) {
            const isActiveView =
              chatModeRef.current === 'dm' && activeDmThreadRef.current === parsed.payload.threadId;
            if (!isActiveView) {
              setDmUnreadCounts((prev) => ({
                ...prev,
                [parsed.payload.threadId]: (prev[parsed.payload.threadId] ?? 0) + 1,
              }));
            }

            if (
              desktopNotificationsEnabledRef.current &&
              notificationPermissionRef.current === 'granted'
            ) {
              new Notification(`DM from @${parsed.payload.senderUsername}`, {
                body: previewText(parsed.payload.text),
              });
            }
          }
        }

        if (parsed.type === 'notification:unread-updated') {
          setChannelUnreadCounts(parsed.payload.summary.channels);
          setDmUnreadCounts(parsed.payload.summary.dmThreads);
        }

        if (parsed.type === 'system') {
          setSystemMessage(parsed.payload.text);
        }

        if (parsed.type === 'voice:participants') {
          voiceMetricsRef.current.joinSuccesses += 1;
          setActiveEffectByUserId(Object.fromEntries(parsed.payload.participants.map((participant) => [participant.userId, participant.activeVoiceEffect ?? 'none'])));
          refreshVoiceDashboard();
          setVoiceParticipantsByChannel((prev) => ({
            ...prev,
            [parsed.payload.channelId]: parsed.payload.participants,
          }));

          for (const participant of parsed.payload.participants) {
            if (participant.userId === auth.user.id) {
              continue;
            }

            void createPeerConnection(participant.userId, parsed.payload.channelId, true);
          }
        }

        if (parsed.type === 'voice:user-joined') {
          setVoiceParticipantsByChannel((prev) => {
            const existing = prev[parsed.payload.channelId] ?? [];
            if (existing.some((item) => item.userId === parsed.payload.participant.userId)) {
              return prev;
            }

            return {
              ...prev,
              [parsed.payload.channelId]: [...existing, parsed.payload.participant],
            };
          });
        }

        if (parsed.type === 'voice:user-left') {
          setVoiceParticipantsByChannel((prev) => ({
            ...prev,
            [parsed.payload.channelId]: (prev[parsed.payload.channelId] ?? []).filter(
              (participant) => participant.userId !== parsed.payload.userId,
            ),
          }));
          closePeerConnection(parsed.payload.userId);
        }

        if (parsed.type === 'screen:share-start') {
          setActiveScreenShare({
            channelId: parsed.payload.channelId,
            presenter: parsed.payload.presenter,
          });
          if (parsed.payload.presenter.userId !== auth.user.id) {
            setRemoteScreenStream(null);
          }
        }

        if (parsed.type === 'screen:share-stop') {
          for (const userId of Array.from(screenPeerConnectionsRef.current.keys())) {
            closeScreenPeerConnection(userId);
          }
          if (parsed.payload.presenterUserId === auth.user.id) {
            stopAllScreenShare();
          }
          setActiveScreenShare((prev) => {
            if (!prev || prev.presenter.userId !== parsed.payload.presenterUserId) {
              return prev;
            }
            return null;
          });
          setRemoteScreenStream(null);
          setScreenShareScopeWarning(null);
          setScreenConsentState('idle');
        }

        if (parsed.type === 'screen:viewer-joined') {
          if (parsed.payload.presenterUserId === auth.user.id) {
            void createScreenPeerConnection(
              parsed.payload.viewer.userId,
              parsed.payload.channelId,
              true,
              'screen',
            );
          }
        }

        if (parsed.type === 'screen:viewer-left') {
          closeScreenPeerConnection(parsed.payload.userId);
        }

        if (parsed.type === 'moderation:audit') {
          setSystemMessage(`Moderation event: ${parsed.payload.action.replaceAll('_', ' ')}`);
        }

        if (parsed.type === 'screen:signal') {
          const { channelId, fromUserId, description, candidate } = parsed.payload;
          void (async () => {
            const socket = socketRef.current;
            if (!socket || socket.readyState !== WebSocket.OPEN) {
              return;
            }

            const peerConnection = await createScreenPeerConnection(
              fromUserId,
              channelId,
              false,
              'screen',
            );
            if (!peerConnection) {
              return;
            }

            if (isRtcSessionDescriptionInit(description)) {
              await peerConnection.setRemoteDescription(description);
              if (description.type === 'offer') {
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.send(
                  JSON.stringify({
                    type: 'screen:signal',
                    payload: {
                      channelId,
                      targetUserId: fromUserId,
                      streamType: 'screen',
                      description: answer,
                    },
                  }),
                );
              }
            }

            if (candidate) {
              await peerConnection.addIceCandidate(candidate);
            }
          })().catch(() => {
            setError('Screen share signaling failed.');
          });
        }

        if (parsed.type === 'watch:start' || parsed.type === 'watch:pause' || parsed.type === 'watch:seek') {
          setCoWatchState(parsed.payload.state);
          syncVideoToState(parsed.payload.state);
        }

        if (parsed.type === 'watch:state') {
          setCoWatchState(parsed.payload.state);
          if (parsed.payload.state) {
            syncVideoToState(parsed.payload.state);
          }
        }

        if (parsed.type === 'voice:effect-state') {
          setActiveEffectByUserId((current) => ({ ...current, [parsed.payload.userId]: parsed.payload.effect }));
        }

        if (parsed.type === 'soundboard:trigger') {
          setSystemMessage(`${parsed.payload.username} played ${parsed.payload.clipId}.`);
        }

        if (parsed.type === 'voice:signal') {
          const { channelId, fromUserId, description, candidate } = parsed.payload;
          void (async () => {
            const peerConnection = await createPeerConnection(fromUserId, channelId, false);
            if (!peerConnection) {
              return;
            }

            if (isRtcSessionDescriptionInit(description)) {
              await peerConnection.setRemoteDescription(description);
              if (description.type === 'offer') {
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.send(
                  JSON.stringify({
                    type: 'voice:signal',
                    payload: {
                      channelId,
                      targetUserId: fromUserId,
                      streamType: 'audio',
                      description: answer,
                      iceRestart: false,
                    },
                  }),
                );
              }
            }

            if (candidate) {
              await peerConnection.addIceCandidate(candidate);
            }
          })().catch(() => {
            addDisconnectCause('signal_failure');
            setError('Voice signaling failed. Try rejoining voice.');
            console.error('[voice] signal_failure');
          });
        }

        if (parsed.type === 'error') {
          setError(parsed.payload.message);
          console.error('[ws] server_error', parsed.payload.message);
        }
      });

      socket.addEventListener('close', () => {
        if (socket !== currentSocketRef.current) {
          return;
        }

        stopAllVoice();
        setVoiceChannelId(null);
        setConnectionState('closed');
        setError('Disconnected from chat server.');
        addDisconnectCause('socket_close');
        console.warn('[ws] disconnected');

        if (shouldReconnectRef.current) {
          const attempt = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = attempt;
          const delay = Math.min(
            RECONNECT_MAX_DELAY_MS,
            RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
          );
          reconnectTimeoutRef.current = window.setTimeout(connectSocket, delay);
        }
      });

      socket.addEventListener('error', () => {
        console.error('[ws] transport_error');
      });
    };

    connectSocket();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      sendTypingStop();
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'voice:leave-channel', payload: {} }));
      }
      stopAllVoice();
      currentSocketRef.current?.close();
      socketRef.current = null;
      currentSocketRef.current = null;
    };
  }, [wsUrl, auth?.user.id, activeServerId]);

  useEffect(() => {
    const video = watchVideoRef.current;
    if (!video) {
      return;
    }

    const sourceUrl = coWatchState?.media.url;
    if (!sourceUrl) {
      video.removeAttribute('src');
      video.load();
      return;
    }

    if (video.src !== sourceUrl) {
      video.src = sourceUrl;
      video.load();
    }

    syncVideoToState(coWatchState);
  }, [coWatchState]);

  useEffect(() => {
    const video = remoteScreenVideoRef.current;
    if (!video) {
      return;
    }

    video.srcObject = remoteScreenStream;
    if (remoteScreenStream) {
      void video.play().catch(() => {
        setError('Click anywhere on the page once to allow screen playback.');
      });
    }
  }, [remoteScreenStream]);

  useEffect(() => {
    const stopRecorder = () => {
      highlightRecorderRef.current?.stop();
      highlightRecorderRef.current = null;
      highlightCaptureStreamRef.current?.getTracks().forEach((track) => track.stop());
      highlightCaptureStreamRef.current = null;
    };

    if (!highlightCaptureEnabled) {
      stopRecorder();
      highlightBufferRef.current = [];
      setHighlightRecorderState('disabled');
      return;
    }

    if (!remoteScreenStream || typeof MediaRecorder === 'undefined') {
      setHighlightRecorderState('disabled');
      return;
    }

    const captureStream = new MediaStream();
    remoteScreenStream.getVideoTracks().forEach((track) => captureStream.addTrack(track.clone()));
    remoteScreenStream.getAudioTracks().forEach((track) => captureStream.addTrack(track.clone()));
    processedLocalVoiceStreamRef.current?.getAudioTracks().forEach((track) => captureStream.addTrack(track.clone()));

    if (captureStream.getTracks().length === 0) {
      setHighlightRecorderState('disabled');
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';

    const recorder = new MediaRecorder(captureStream, { mimeType });
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const now = Date.now();
      highlightBufferRef.current = [...highlightBufferRef.current, { blob: event.data, capturedAt: now }].filter(
        (entry) => now - entry.capturedAt <= HIGHLIGHT_BUFFER_MS,
      );
    };
    recorder.start(HIGHLIGHT_CHUNK_MS);
    highlightRecorderRef.current = recorder;
    highlightCaptureStreamRef.current = captureStream;
    setHighlightRecorderState('buffering');

    return () => {
      stopRecorder();
    };
  }, [highlightCaptureEnabled, remoteScreenStream]);

  useEffect(() => {
    if (!voiceChannelId || !activeChannelId || voiceChannelId === activeChannelId) {
      return;
    }

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'voice:leave-channel', payload: {} }));
    }

    stopAllVoice();
    setVoiceChannelId(null);
    console.info('[voice] leave_local');
  }, [activeChannelId, voiceChannelId]);

  useEffect(() => {
    if (!activeScreenShare || !activeChannelId) {
      return;
    }

    if (activeScreenShare.channelId !== activeChannelId) {
      setRemoteScreenStream(null);
    }
  }, [activeChannelId, activeScreenShare]);

  useEffect(() => {
    if (activeChannelId) {
      setChannelUnreadCounts((prev) => ({ ...prev, [activeChannelId]: 0 }));
      void markActiveChannelRead(activeChannelId).catch(() => {
        // best-effort read marker update
      });
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeChannelId) {
      return;
    }

    setPendingAttachmentUploads([]);
    setMessages([]);
    setSearchQuery('');
    setSearchResults([]);
    setSearchNextCursor(null);
    setSearchCursorTrail([null]);
    setSearchError(null);
    socket.send(
      JSON.stringify({
        type: 'chat:join-channel',
        payload: { channelId: activeChannelId },
      }),
    );
  }, [activeChannelId, connectionState]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeServerId) {
      return;
    }

    socket.send(
      JSON.stringify({ type: 'presence:join-server', payload: { serverId: activeServerId } }),
    );
  }, [activeServerId, connectionState]);

  useEffect(() => {
    if (activeDmThreadId) {
      setDmUnreadCounts((prev) => ({ ...prev, [activeDmThreadId]: 0 }));
      void markActiveDmThreadRead(activeDmThreadId).catch(() => {
        // best-effort read marker update
      });
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeDmThreadId) {
      return;
    }

    setDmMessages([]);
    setSearchQuery('');
    setSearchResults([]);
    setSearchNextCursor(null);
    setSearchCursorTrail([null]);
    setSearchError(null);
    socket.send(
      JSON.stringify({
        type: 'dm:join-thread',
        payload: { threadId: activeDmThreadId },
      }),
    );
  }, [activeDmThreadId, connectionState]);

  function renderMessageText(text: string, currentUsername: string) {
    const segments = parseMentionSegments(text);
    return (
      <>
        {segments.map((segment, index) => {
          const isSelfMention =
            segment.mentioned &&
            segment.text.slice(1).toLowerCase() === currentUsername.toLowerCase();
          const className = isSelfMention
            ? 'mention mention-self'
            : segment.mentioned
              ? 'mention'
              : undefined;
          return (
            <Fragment key={`${segment.text}-${index}`}>
              {className ? <mark className={className}>{segment.text}</mark> : segment.text}
            </Fragment>
          );
        })}
      </>
    );
  }

  async function toggleDesktopNotifications(enabled: boolean) {
    if (!enabled) {
      setDesktopNotificationsEnabled(false);
      return;
    }

    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotificationPermission('unsupported');
      setError('Desktop notifications are not supported in this browser.');
      return;
    }

    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission !== 'granted') {
      setDesktopNotificationsEnabled(false);
      setError('Desktop notification permission was not granted.');
      return;
    }

    setDesktopNotificationsEnabled(true);
    setError(null);
  }

  async function runSearch(beforeCursor: string | null = null, trail: (string | null)[] = [null]) {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchNextCursor(null);
      setSearchCursorTrail([null]);
      setSearchError(null);
      return;
    }

    const path =
      chatMode === 'dm'
        ? `/dm/messages/search?threadId=${encodeURIComponent(String(activeDmThreadId ?? ''))}&query=${encodeURIComponent(query)}&limit=${SEARCH_PAGE_SIZE}${beforeCursor ? `&before=${encodeURIComponent(beforeCursor)}` : ''}`
        : `/messages/search?channelId=${encodeURIComponent(String(activeChannelId ?? ''))}&query=${encodeURIComponent(query)}&limit=${SEARCH_PAGE_SIZE}${beforeCursor ? `&before=${encodeURIComponent(beforeCursor)}` : ''}`;

    if ((chatMode === 'dm' && !activeDmThreadId) || (chatMode === 'channel' && !activeChannelId)) {
      return;
    }

    setIsSearching(true);
    setSearchError(null);
    try {
      const res = await authedFetch(path);
      if (!res.ok) {
        throw new Error('Unable to search messages.');
      }

      const data = (await res.json()) as {
        messages: (ChatMessage | DmMessage)[];
        nextCursor: string | null;
        prevCursor: string | null;
      };
      setSearchResults(data.messages);
      setSearchNextCursor(data.nextCursor);
      setSearchCursorTrail(trail);
    } catch (reason) {
      setSearchError(reason instanceof Error ? reason.message : 'Unable to search messages.');
    } finally {
      setIsSearching(false);
    }
  }

  async function joinVoice() {
    if (!activeChannelId) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('Voice needs an active realtime connection.');
      return;
    }

    try {
      voiceMetricsRef.current.joinAttempts += 1;
      refreshVoiceDashboard();
      await ensureLocalVoiceStream();
      socket.send(
        JSON.stringify({ type: 'voice:join-channel', payload: { channelId: activeChannelId } }),
      );
      socket.send(
        JSON.stringify({ type: 'voice:effect-state', payload: { channelId: activeChannelId, effect: selectedVoiceEffect } }),
      );
      setVoiceChannelId(activeChannelId);
      setError(null);
      console.info('[voice] join_attempt', { channelId: activeChannelId });
    } catch {
      addDisconnectCause('microphone_permission');
      setError('Microphone access is required for voice chat.');
    }
  }

  async function startScreenShare() {
    if (!activeChannelId || voiceChannelId !== activeChannelId) {
      setError('Join voice in this channel before sharing your screen.');
      return;
    }

    if (activeScreenShare && activeScreenShare.presenter.userId !== auth?.user.id) {
      setError('Another presenter is already sharing a screen.');
      return;
    }

    if (voiceParticipants.length > SCREEN_P2P_PARTICIPANT_THRESHOLD) {
      setError('This room is over the P2P threshold. SFU rollout is planned for larger rooms.');
      return;
    }

    if (!auth) {
      setError('Sign in before sharing your screen.');
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('Screen share needs an active realtime connection.');
      return;
    }

    try {
      setScreenConsentState('prompting');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      setScreenConsentState('granted');
      localScreenStreamRef.current = stream;
      const [videoTrack] = stream.getVideoTracks();
      if (videoTrack) {
        const label = videoTrack.label.toLowerCase();
        if (label.includes('screen') || label.includes('display') || label.includes('monitor')) {
          setScreenShareScopeWarning(
            'You are sharing your entire display. Close sensitive apps and notifications.',
          );
        } else {
          setScreenShareScopeWarning(
            'You are sharing a single window/tab. Make sure confidential content stays hidden.',
          );
        }

        videoTrack.onended = () => {
          stopScreenShare();
        };
      }

      socket.send(
        JSON.stringify({ type: 'screen:share-start', payload: { channelId: activeChannelId } }),
      );
      setActiveScreenShare({
        channelId: activeChannelId,
        presenter: { userId: auth.user.id, username: auth.user.username },
      });
      setRemoteScreenStream(stream);
      for (const participant of voiceParticipants) {
        if (participant.userId === auth.user.id) {
          continue;
        }
        void createScreenPeerConnection(participant.userId, activeChannelId, true, 'screen');
      }
      monitorScreenNetworkAndAdapt();
      setError(null);
    } catch {
      setScreenConsentState('denied');
      setError('Screen share permission is required.');
    }
  }

  function forceStopScreenShare() {
    if (!activeScreenShare || !activeChannelId) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('Screen share moderation needs an active realtime connection.');
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'screen:force-stop',
        payload: {
          channelId: activeChannelId,
          presenterUserId: activeScreenShare.presenter.userId,
        },
      }),
    );
  }

  function stopScreenShare() {
    const socket = socketRef.current;
    const channelId = activeScreenShare?.channelId ?? activeChannelId;
    if (socket && socket.readyState === WebSocket.OPEN && channelId && auth) {
      if (activeScreenShare?.presenter.userId === auth.user.id) {
        socket.send(JSON.stringify({ type: 'screen:share-stop', payload: { channelId } }));
      }
    }

    stopAllScreenShare();
    setScreenShareScopeWarning(null);
    setScreenConsentState('idle');
    setActiveScreenShare((prev) => {
      if (prev && prev.presenter.userId === auth?.user.id) {
        return null;
      }
      return prev;
    });
  }

  function leaveVoice() {
    stopScreenShare();
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'voice:leave-channel', payload: {} }));
    }

    stopAllVoice();
    setVoiceChannelId(null);
    console.info('[voice] leave_local');
  }

  function sendMessage() {
    const socket = socketRef.current;
    const text = draft.trim();
    if (!socket || socket.readyState !== WebSocket.OPEN || !text) {
      return;
    }

    if (chatMode === 'dm') {
      if (!activeDmThreadId) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: 'dm:send',
          payload: { text },
        }),
      );
      setDraft('');
      setError(null);
      return;
    }

    if (!activeChannelId) {
      return;
    }

    sendTypingStop(activeChannelId);
    lastSentChannelTextRef.current = text;
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        payload: {
          text,
          attachmentIds: pendingAttachmentUploads
            .filter((item) => item.status === 'uploaded' && item.attachmentId)
            .map((item) => item.attachmentId as string),
        },
      }),
    );
    setDraft('');
    setPendingAttachmentUploads([]);
    setError(null);
  }


  async function copyTextToClipboard(messageId: string, text: string) {
    if (!navigator.clipboard) {
      setError('Clipboard access is not available in this browser.');
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopiedAiMessageId(messageId);
      window.setTimeout(() => setCopiedAiMessageId((prev) => (prev === messageId ? null : prev)), 1200);
    } catch {
      setError('Unable to copy message text.');
    }
  }

  function retryAiPrompt(requestId: string) {
    const promptText = aiPromptByRequestId[requestId]?.trim();
    const socket = socketRef.current;

    if (!promptText || !socket || socket.readyState !== WebSocket.OPEN || !activeChannelId) {
      setError('Unable to retry this AI request.');
      return;
    }

    sendTypingStop(activeChannelId);
    lastSentChannelTextRef.current = promptText;
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        payload: {
          text: promptText,
          attachmentIds: [],
        },
      }),
    );
  }

  function coWatchSend(event: object) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(event));
  }

  function syncVideoToState(state: CoWatchPlaybackState) {
    const video = watchVideoRef.current;
    if (!video) {
      return;
    }

    const expectedPosition =
      state.paused ? state.positionSec : state.positionSec + Math.max(0, (Date.now() - Date.parse(state.lastEventAt)) / 1000);
    const drift = Math.abs(video.currentTime - expectedPosition);

    if (drift > 0.75) {
      coWatchSuppressSyncRef.current = true;
      video.currentTime = expectedPosition;
      window.setTimeout(() => {
        coWatchSuppressSyncRef.current = false;
      }, 120);
    }

    if (state.paused && !video.paused) {
      void video.pause();
    }

    if (!state.paused && video.paused) {
      void video.play().catch(() => {
        setError('Click on the page to allow co-watch media playback.');
      });
    }
  }

  function sendWatchStateEvent(type: 'watch:pause' | 'watch:seek', paused: boolean, positionSec: number) {
    if (!activeChannelId) {
      return;
    }

    coWatchSend({
      type,
      payload: {
        channelId: activeChannelId,
        paused,
        positionSec,
        eventAt: new Date().toISOString(),
      },
    });
  }

  function startCoWatchFromMedia(media: CoWatchMediaSource) {
    if (!activeChannelId) {
      setError('Choose a channel first.');
      return;
    }

    coWatchSend({
      type: 'watch:start',
      payload: {
        channelId: activeChannelId,
        media,
        paused: true,
        positionSec: 0,
        eventAt: new Date().toISOString(),
      },
    });
  }

  async function uploadAttachment(file: File, uploadKind: 'attachment' | 'clip' = 'attachment') {
    if (!activeChannelId || !auth) {
      setError('Select a channel before uploading attachments.');
      return null;
    }

    const localId = crypto.randomUUID();
    const category = deriveAttachmentCategory(file.type);
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;

    setPendingAttachmentUploads((prev) => [
      ...prev,
      {
        localId,
        fileName: file.name,
        mimeType: file.type,
        category,
        progress: 0,
        status: 'uploading',
        previewUrl,
      },
    ]);

    try {
      const formData = new FormData();
      formData.set('channelId', activeChannelId);
      formData.set('file', file);
      if (uploadKind === 'clip') {
        formData.set('uploadKind', 'clip');
      }

      const data = await new Promise<{ attachment: { id: string } }>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', `${apiBase}/uploads/attachments`);
        request.setRequestHeader('Authorization', `Bearer ${auth.accessToken}`);
        request.upload.addEventListener('progress', (event) => {
          if (!event.lengthComputable) return;
          const progress = Math.round((event.loaded / event.total) * 100);
          setPendingAttachmentUploads((prev) =>
            prev.map((item) => (item.localId === localId ? { ...item, progress } : item)),
          );
        });
        request.addEventListener('load', () => {
          if (request.status < 200 || request.status >= 300) {
            reject(new Error('Unable to upload attachment.'));
            return;
          }

          try {
            resolve(JSON.parse(request.responseText) as { attachment: { id: string } });
          } catch {
            reject(new Error('Unexpected upload response.'));
          }
        });
        request.addEventListener('error', () => reject(new Error('Upload request failed.')));
        request.send(formData);
      });

      setPendingAttachmentUploads((prev) =>
        prev.map((item) =>
          item.localId === localId
            ? { ...item, progress: 100, status: 'uploaded', attachmentId: data.attachment.id }
            : item,
        ),
      );
      setError(null);
      return data.attachment.id;
    } catch {
      setPendingAttachmentUploads((prev) =>
        prev.map((item) => (item.localId === localId ? { ...item, status: 'failed' } : item)),
      );
      setError(uploadKind === 'clip' ? 'Unable to upload highlight clip.' : 'Unable to upload attachment.');
      return null;
    }
  }

  async function saveHighlightClip() {
    if (!highlightCaptureEnabled) {
      setError('Enable highlight capture before saving clips.');
      return;
    }

    const chunks = highlightBufferRef.current;
    if (chunks.length === 0) {
      setError('No buffered highlight available yet.');
      return;
    }

    setHighlightRecorderState('saving');
    const clipBlob = new Blob(
      chunks.filter((entry) => entry.blob.size > 0).map((entry) => entry.blob),
      { type: 'video/webm' },
    );
    if (clipBlob.size === 0) {
      setHighlightRecorderState('buffering');
      setError('No buffered highlight available yet.');
      return;
    }

    const fileName = `highlight-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
    const clipFile = new File([clipBlob], fileName, { type: 'video/webm' });

    const objectUrl = URL.createObjectURL(clipBlob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(objectUrl);

    if (highlightUploadOnSave) {
      await uploadAttachment(clipFile, 'clip');
      setDraft((prev) => (prev.trim().length > 0 ? prev : 'Saved a voice/screen highlight clip.'));
    }

    setSystemMessage('Saved last 30 seconds clip locally.');
    setHighlightRecorderState('buffering');
    setError(null);
  }
  async function submitAuthForm(event: FormEvent) {
    event.preventDefault();

    const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
    try {
      const res = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, password: passwordInput }),
      });

      const data = (await res.json()) as
        | {
            user: { id: string; username: string };
            tokens: { accessToken: string; refreshToken: string };
          }
        | { error: string };

      if (!res.ok || 'error' in data) {
        setError('error' in data ? data.error : 'Unable to authenticate.');
        return;
      }

      updateAuth({
        user: data.user,
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
      });

      setUsernameInput('');
      setPasswordInput('');
      setError(null);
    } catch {
      setError(`Unable to reach authentication server at ${apiBase}.`);
    }
  }

  async function createServer(event: FormEvent) {
    event.preventDefault();
    const name = serverNameInput.trim();
    if (!name) {
      return;
    }

    const res = await authedFetch('/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      setError('Unable to create server.');
      return;
    }

    setServerNameInput('');
    await loadServers();
  }

  async function createChannel(event: FormEvent) {
    event.preventDefault();
    const name = channelNameInput.trim();
    if (!name || !activeServerId) {
      return;
    }

    const res = await authedFetch(`/servers/${activeServerId}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      setError('Unable to create channel.');
      return;
    }

    setChannelNameInput('');
    await loadChannels(activeServerId);
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    const username = inviteUsernameInput.trim().toLowerCase();
    if (!username || !activeServerId) {
      return;
    }

    const res = await authedFetch(`/servers/${activeServerId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });

    if (!res.ok) {
      setError('Unable to add member (owner-only action).');
      return;
    }

    setInviteUsernameInput('');
    await loadMembers(activeServerId);
    setError(null);
  }

  async function startDm(event: FormEvent) {
    event.preventDefault();
    const username = dmUsernameInput.trim().toLowerCase();
    if (!username) {
      return;
    }

    const res = await authedFetch('/dm/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });

    if (!res.ok) {
      setError('Unable to start DM.');
      return;
    }

    const data = (await res.json()) as { threadId: string };
    setDmUsernameInput('');
    setChatMode('dm');
    setActiveDmThreadId(data.threadId);
    await loadDmThreads();
    setError(null);
  }

  async function editMessage(messageId: string) {
    const text = editDraft.trim();
    if (!text || text.length > 300) {
      setError('Edited message must be between 1 and 300 characters.');
      return;
    }

    const res = await authedFetch(`/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      setError('Unable to edit message.');
      return;
    }

    const data = (await res.json()) as {
      message: { id: string; channelId: string; text: string; editedAt: string };
    };

    setMessages((prev) =>
      prev.map((message) =>
        message.id === data.message.id
          ? { ...message, text: data.message.text, editedAt: data.message.editedAt }
          : message,
      ),
    );
    setEditingMessageId(null);
    setEditDraft('');
    if (activeServerId) {
      await loadAuditLogs(activeServerId);
    }
    setError(null);
  }

  async function deleteMessage(messageId: string) {
    const res = await authedFetch(`/messages/${messageId}`, { method: 'DELETE' });
    if (!res.ok) {
      setError('Unable to delete message.');
      return;
    }

    if (chatMode === 'channel') {
      setMessages((prev) => prev.filter((message) => message.id !== messageId));
    }

    if (activeServerId) {
      await loadAuditLogs(activeServerId);
    }
    setError(null);
  }

  async function reportMessage(messageId: string) {
    const res = await authedFetch(`/messages/${messageId}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      setError('Unable to report message.');
      return;
    }

    if (activeServerId) {
      await loadAuditLogs(activeServerId);
    }
    setError(null);
  }

  async function muteMember(userId: string) {
    if (!activeServerId) {
      return;
    }

    const res = await authedFetch(`/servers/${activeServerId}/mutes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });

    if (!res.ok) {
      setError('Unable to mute member.');
      return;
    }

    await Promise.all([loadAuditLogs(activeServerId), loadMembers(activeServerId)]);
    setError(null);
  }


  async function unmuteMember(userId: string) {
    if (!activeServerId) {
      return;
    }

    const res = await authedFetch(`/servers/${activeServerId}/mutes/${userId}`, { method: 'DELETE' });

    if (!res.ok) {
      setError('Unable to unmute member.');
      return;
    }

    await Promise.all([loadAuditLogs(activeServerId), loadMembers(activeServerId)]);
    setError(null);
  }

  async function updateMemberPermission(userId: string, canShareScreen: boolean) {
    if (!activeServerId) {
      return;
    }

    const res = await authedFetch(`/servers/${activeServerId}/members/${userId}/permissions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canShareScreen }),
    });

    if (!res.ok) {
      setError('Unable to update member permissions.');
      return;
    }

    await Promise.all([loadAuditLogs(activeServerId), loadMembers(activeServerId)]);
    setError(null);
  }

  async function logout() {
    if (auth?.refreshToken) {
      await fetch(`${apiBase}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken }),
      });
    }

    sendTypingStop();
    socketRef.current?.close();
    updateAuth(null);
  }

  if (!auth) {
    return (
      <main className="chat-layout auth-layout">
        <h1>{APP_NAME}</h1>
        <p className="subtle">Create an account or sign in to enter chat.</p>

        <div className="auth-toggle" role="tablist" aria-label="Authentication mode">
          <button
            type="button"
            className={authMode === 'login' ? 'active' : ''}
            onClick={() => setAuthMode('login')}
          >
            Login
          </button>
          <button
            type="button"
            className={authMode === 'register' ? 'active' : ''}
            onClick={() => setAuthMode('register')}
          >
            Register
          </button>
        </div>

        <form className="auth-form" onSubmit={submitAuthForm}>
          <label>
            Username
            <input
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              minLength={3}
              maxLength={32}
              required
            />
          </label>
          <label>
            Password
            <input
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              type="password"
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          <button type="submit">{authMode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>

        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main className="chat-layout guild-layout">
      <header className="chat-header">
        <div>
          <h1>{APP_NAME}</h1>
          <p className="subtle">
            Signed in as <strong>{auth.user.username}</strong>
          </p>
          <p className="subtle">
            Status: <strong>{connectionState}</strong> · {systemMessage}
          </p>
        </div>
        <button type="button" className="logout-button" onClick={logout}>
          Logout
        </button>
      </header>

      <section className="guild-shell">
        <aside className="app-rail left-rail">
          <section className="sidebar rail-panel always-visible" data-priority="always-visible">
            <h3>
              Servers <span className="panel-priority">always visible</span>
            </h3>
          <div className="list">
            {servers.map((server) => (
              <button
                key={server.id}
                type="button"
                className={server.id === activeServerId ? 'list-item active' : 'list-item'}
                onClick={() => setActiveServerId(server.id)}
              >
                {server.name}
              </button>
            ))}
          </div>
            <form className="inline-form" onSubmit={createServer}>
            <input
              value={serverNameInput}
              onChange={(event) => setServerNameInput(event.target.value)}
              placeholder="New server"
            />
            <button type="submit">Create</button>
            </form>
          </section>

          <section className="sidebar rail-panel always-visible" data-priority="always-visible">
            <h3>
              Channels {totalChannelUnread > 0 ? `(${totalChannelUnread})` : ''}{' '}
              <span className="panel-priority">always visible</span>
            </h3>
          <div className="list">
            {channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className={channel.id === activeChannelId ? 'list-item active' : 'list-item'}
                onClick={() => setActiveChannelId(channel.id)}
              >
                #{channel.name}
                {(channelUnreadCounts[channel.id] ?? 0) > 0 && (
                  <span className="unread-badge">{channelUnreadCounts[channel.id]}</span>
                )}
              </button>
            ))}
          </div>
            <form className="inline-form" onSubmit={createChannel}>
            <input
              value={channelNameInput}
              onChange={(event) => setChannelNameInput(event.target.value)}
              placeholder="New channel"
            />
            <button type="submit" disabled={!activeServerId}>
              Add
            </button>
            </form>
            <form className="inline-form" onSubmit={addMember}>
            <input
              value={inviteUsernameInput}
              onChange={(event) => setInviteUsernameInput(event.target.value)}
              placeholder="Invite username"
            />
            <button type="submit" disabled={!activeServerId}>
              Invite
            </button>
            </form>
          </section>

          <section className="sidebar rail-panel collapsible-panel" data-priority="collapsible">
            <h3>
              Direct Messages {totalDmUnread > 0 ? `(${totalDmUnread})` : ''}{' '}
              <span className="panel-priority">collapsible</span>
            </h3>
          <div className="list">
            {dmThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={
                  thread.id === activeDmThreadId && chatMode === 'dm'
                    ? 'list-item active'
                    : 'list-item'
                }
                onClick={() => {
                  setChatMode('dm');
                  setActiveDmThreadId(thread.id);
                }}
              >
                @{thread.otherUsername}
                {(dmUnreadCounts[thread.id] ?? 0) > 0 && (
                  <span className="unread-badge">{dmUnreadCounts[thread.id]}</span>
                )}
              </button>
            ))}
          </div>
          <form className="inline-form" onSubmit={startDm}>
            <input
              value={dmUsernameInput}
              onChange={(event) => setDmUsernameInput(event.target.value)}
              placeholder="Start DM (username)"
            />
            <button type="submit">Start</button>
          </form>
            <button type="button" className="list-item" onClick={() => setChatMode('channel')}>
              Back to channels
            </button>
          </section>
        </aside>

        <section className="chat-panel center-rail">
          <aside className="app-rail right-rail">
            <section className="voice-panel rail-panel always-visible" data-priority="always-visible">
            <div>
              <strong>Voice</strong>
              <p className="subtle">
                {voiceChannelId === activeChannelId
                  ? `Connected in #${channels.find((channel) => channel.id === activeChannelId)?.name ?? 'channel'}`
                  : 'Join voice for the active channel'}
              </p>
            </div>
            <div className="voice-panel-actions">
              {voiceChannelId === activeChannelId ? (
                <button type="button" onClick={leaveVoice}>
                  Leave voice
                </button>
              ) : (
                <button type="button" onClick={() => void joinVoice()} disabled={!activeChannelId}>
                  Join voice
                </button>
              )}
              {activeScreenShare?.presenter.userId === auth.user.id ? (
                <button type="button" onClick={stopScreenShare}>
                  Stop sharing
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void startScreenShare()}
                  disabled={
                    voiceChannelId !== activeChannelId ||
                    !!activeScreenShare ||
                    voiceParticipants.length > SCREEN_P2P_PARTICIPANT_THRESHOLD ||
                    (currentMember ? !currentMember.canShareScreen : false)
                  }
                >
                  Start screen share
                </button>
              )}
              {isServerOwner &&
                activeScreenShare &&
                activeScreenShare.presenter.userId !== auth.user.id && (
                  <button type="button" onClick={forceStopScreenShare}>
                    Force stop share
                  </button>
                )}
            </div>
            </section>

            <section className="voice-panel rail-panel collapsible-panel" data-priority="collapsible">
            <div>
              <strong>Co-watch</strong>
              <p className="subtle">Synchronized media viewing in this channel.</p>
            </div>
            <div className="inline-form">
              <input
                value={coWatchUrlInput}
                onChange={(event) => setCoWatchUrlInput(event.target.value)}
                placeholder="Paste media URL"
              />
              <button
                type="button"
                onClick={() =>
                  startCoWatchFromMedia({ sourceType: 'url', url: coWatchUrlInput.trim(), title: coWatchUrlInput.trim() })
                }
                disabled={!coWatchUrlInput.trim() || !activeChannelId || !canControlCoWatch}
              >
                Load URL
              </button>
              <input
                type="file"
                accept="video/*,audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    return;
                  }

                  if (coWatchLocalMedia?.objectUrl) {
                    URL.revokeObjectURL(coWatchLocalMedia.objectUrl);
                  }

                  const objectUrl = URL.createObjectURL(file);
                  setCoWatchLocalMedia({ fileName: file.name, objectUrl });
                  startCoWatchFromMedia({ sourceType: 'upload', url: objectUrl, title: file.name });
                }}
                disabled={!activeChannelId || !canControlCoWatch}
              />
            </div>
            <div className="inline-form">
              <button
                type="button"
                onClick={() => {
                  const video = watchVideoRef.current;
                  if (!video || !activeChannelId) {
                    return;
                  }
                  sendWatchStateEvent('watch:pause', !video.paused, video.currentTime);
                }}
                disabled={!coWatchState || !canControlCoWatch}
              >
                {coWatchState?.paused ? 'Play' : 'Pause'}
              </button>
              <button
                type="button"
                onClick={() => {
                  const video = watchVideoRef.current;
                  if (!video || !canControlCoWatch) {
                    return;
                  }
                  sendWatchStateEvent('watch:seek', video.paused, Math.max(0, video.currentTime - 10));
                }}
                disabled={!coWatchState || !canControlCoWatch}
              >
                -10s
              </button>
              <button
                type="button"
                onClick={() => {
                  const video = watchVideoRef.current;
                  if (!video || !canControlCoWatch) {
                    return;
                  }
                  sendWatchStateEvent('watch:seek', video.paused, video.currentTime + 10);
                }}
                disabled={!coWatchState || !canControlCoWatch}
              >
                +10s
              </button>
              {coWatchState && coWatchState.hostUserId === auth.user.id && voiceParticipants.find((participant) => participant.userId !== auth.user.id) && (
                <button
                  type="button"
                  onClick={() => {
                    const target = voiceParticipants.find((participant) => participant.userId !== auth.user.id);
                    if (!target || !activeChannelId) {
                      return;
                    }

                    coWatchSend({
                      type: 'watch:transfer-host',
                      payload: { channelId: activeChannelId, targetUserId: target.userId },
                    });
                  }}
                >
                  Transfer host
                </button>
              )}
              {coWatchState && coWatchState.hostUserId === auth.user.id && (
                <label>
                  <input
                    type="checkbox"
                    checked={coWatchAllowOthersControl}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setCoWatchAllowOthersControl(checked);
                      const controllers = checked
                        ? voiceParticipants.map((participant) => participant.userId).filter((userId) => userId !== auth.user.id)
                        : [];
                      coWatchSend({ type: 'watch:set-permissions', payload: { channelId: activeChannelId, controllers } });
                    }}
                  />
                  Allow others to control
                </label>
              )}
            </div>
            {coWatchLocalMedia && <p className="subtle">Loaded local media: {coWatchLocalMedia.fileName}</p>}
            {coWatchState && (
              <video
                ref={watchVideoRef}
                controls
                playsInline
                onPause={() => {
                  if (!canControlCoWatch || coWatchSuppressSyncRef.current) {
                    return;
                  }
                  const video = watchVideoRef.current;
                  if (video) {
                    sendWatchStateEvent('watch:pause', true, video.currentTime);
                  }
                }}
                onPlay={() => {
                  if (!canControlCoWatch || coWatchSuppressSyncRef.current) {
                    return;
                  }
                  const video = watchVideoRef.current;
                  if (video) {
                    sendWatchStateEvent('watch:pause', false, video.currentTime);
                  }
                }}
                onSeeked={() => {
                  if (!canControlCoWatch || coWatchSuppressSyncRef.current) {
                    return;
                  }
                  const video = watchVideoRef.current;
                  if (video) {
                    sendWatchStateEvent('watch:seek', video.paused, video.currentTime);
                  }
                }}
              />
            )}
            </section>

          <div className="share-consent-card">
            <p className="subtle">
              Browser consent: <strong>{screenConsentState}</strong> · In-app consent:{' '}
              <strong>{activeScreenShare ? 'active' : 'not sharing'}</strong>
            </p>
            <label className="screen-preset-control">
              Screen preset
              <select
                value={screenContentType}
                onChange={(event) => setScreenContentType(event.target.value as ScreenContentType)}
              >
                <option value="text">Text/code (8fps · 0.6Mbps)</option>
                <option value="mixed">Mixed content (15fps · 1.2Mbps)</option>
                <option value="motion">Motion/video (30fps · 2.5Mbps)</option>
              </select>
            </label>
            <p className="subtle">
              Network adaptation: <strong>{screenNetworkQuality}</strong> (packet loss + RTT aware)
            </p>
            <p className="subtle">
              Topology: P2P up to {SCREEN_P2P_PARTICIPANT_THRESHOLD} participants. Planned SFU
              migration above this threshold.
            </p>
            {screenShareScopeWarning && <p className="subtle">{screenShareScopeWarning}</p>}
            {(currentMember ? !currentMember.canShareScreen : false) && (
              <p className="subtle">
                Role gate active: you do not have the "Can share screen" permission.
              </p>
            )}
          </div>
          {activeScreenShare?.presenter.userId === auth.user.id && (
            <div className="share-banner">
              <strong>You are sharing</strong>
              <button type="button" onClick={stopScreenShare}>
                Stop sharing
              </button>
            </div>
          )}

            <section className="voice-panel highlight-panel rail-panel collapsible-panel" data-priority="collapsible">
            <h3>Highlights</h3>
            <label>
              <input
                type="checkbox"
                checked={highlightCaptureEnabled}
                onChange={(event) => setHighlightCaptureEnabled(event.target.checked)}
              />
              I consent to local rolling capture of recent voice/screen moments.
            </label>
            <p className="subtle">Status: {highlightRecorderState === 'buffering' ? 'recording (rolling 30s)' : highlightRecorderState}</p>
            <p className="subtle">Privacy: clips are temporary in memory and replaced after 30 seconds until you save.</p>
            <label>
              <input
                type="checkbox"
                checked={highlightUploadOnSave}
                onChange={(event) => setHighlightUploadOnSave(event.target.checked)}
              />
              Upload saved clip to this channel as an attachment.
            </label>
            <button
              type="button"
              onClick={() => void saveHighlightClip()}
              disabled={!highlightCaptureEnabled || highlightRecorderState === 'saving' || !activeChannelId}
            >
              {highlightRecorderState === 'saving' ? 'Saving clip…' : 'Save last 30 seconds'}
            </button>
            </section>

            <section className="voice-panel rail-panel collapsible-panel" data-priority="collapsible">
            <h3>Playful audio</h3>
            <div className="voice-panel-actions">
              <label>
                Voice effect
                <select
                  value={selectedVoiceEffect}
                  disabled={!activeServer?.voiceEffectsEnabled}
                  onChange={(event) => {
                    const effect = event.target.value as VoiceEffectMode;
                    setSelectedVoiceEffect(effect);
                    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN && activeChannelId) {
                      socketRef.current.send(JSON.stringify({ type: 'voice:effect-state', payload: { channelId: activeChannelId, effect } }));
                    }
                  }}
                >
                  <option value="none">None</option>
                  <option value="robot">Robot</option>
                  <option value="megaphone">Megaphone</option>
                  <option value="pitch-shift">Pitch shift</option>
                </select>
              </label>
              <div className="voice-panel-actions">
                {SOUNDBOARD_CLIPS.map((clip) => (
                  <button
                    key={clip.id}
                    type="button"
                    disabled={!activeServer?.soundboardEnabled || voiceChannelId !== activeChannelId}
                    onClick={() => playBuiltInClip(clip.id)}
                  >
                    {clip.label}
                  </button>
                ))}
              </div>
              <label>
                Custom clip
                <input type="file" accept="audio/*" onChange={(event) => void handleCustomSoundUpload(event.target.files?.[0] ?? null)} />
              </label>
              <button type="button" onClick={playCustomClip} disabled={!customSoundboardClip || !activeServer?.soundboardEnabled}>
                Play upload
              </button>
            </div>
            </section>

            <div className="voice-controls rail-panel collapsible-panel" data-priority="collapsible">
            <label>
              Mic gain {inputGain}%
              <input
                type="range"
                min={0}
                max={200}
                value={inputGain}
                onChange={(event) => setInputGain(Number(event.target.value))}
              />
            </label>
            <div className="subtle">
              Join success: {voiceDashboard.joinSuccessRate.toFixed(0)}% · Median setup:{' '}
              {voiceDashboard.medianSetupMs.toFixed(0)}ms
            </div>
            </div>
            <div className="voice-participants rail-panel collapsible-panel" data-priority="collapsible">
            {voiceParticipants
              .filter((participant) => participant.userId !== auth.user.id)
              .map((participant) => (
                <span key={participant.userId} className="voice-chip">
                  {participant.username}
                  {(activeEffectByUserId[participant.userId] ?? participant.activeVoiceEffect ?? 'none') !== 'none' && (
                    <small className="subtle">fx:{activeEffectByUserId[participant.userId] ?? participant.activeVoiceEffect}</small>
                  )}
                  <strong className="voice-state">
                    {peerStateByUserId[participant.userId] ?? 'connecting'}
                  </strong>
                  {speakingByUserId[participant.userId] && (
                    <span className="speaking-dot" aria-label="speaking" />
                  )}
                  <label className="voice-volume">
                    Vol
                    <input
                      type="range"
                      min={0}
                      max={150}
                      value={outputVolumeByUserId[participant.userId] ?? 100}
                      onChange={(event) =>
                        setOutputVolumeByUserId((prev) => ({
                          ...prev,
                          [participant.userId]: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                </span>
              ))}
            {voiceChannelId === activeChannelId && voiceParticipants.length <= 1 && (
              <span className="subtle">No other participants yet.</span>
            )}
            </div>
            <p className="subtle">
            Disconnect causes:{' '}
            {Object.entries(voiceDashboard.disconnectCauses)
              .map(([cause, count]) => `${cause}: ${count}`)
              .join(', ') || 'none'}
            </p>
          </aside>

          <section className="primary-task">
          <form
            className="inline-form search-bar"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(null, [null]);
            }}
          >
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={chatMode === 'dm' ? 'Search DMs' : 'Search channel messages'}
              aria-label="Search messages"
            />
            <button type="submit" disabled={isSearching}>
              {isSearching ? 'Searching...' : 'Search'}
            </button>
            {showingSearchResults && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults([]);
                  setSearchNextCursor(null);
                  setSearchCursorTrail([null]);
                  setSearchError(null);
                }}
              >
                Clear
              </button>
            )}
          </form>
          {showingSearchResults && (
            <div className="search-pagination">
              <button
                type="button"
                onClick={() => {
                  if (searchCursorTrail.length <= 1) {
                    return;
                  }
                  const previousTrail = searchCursorTrail.slice(0, -1);
                  const previousCursor = previousTrail[previousTrail.length - 1] ?? null;
                  void runSearch(previousCursor, previousTrail);
                }}
                disabled={isSearching || searchCursorTrail.length <= 1}
              >
                Previous
              </button>
              <span className="subtle">Page {searchCursorTrail.length}</span>
              <button
                type="button"
                onClick={() => {
                  if (!searchNextCursor) {
                    return;
                  }
                  const nextTrail = [...searchCursorTrail, searchNextCursor];
                  void runSearch(searchNextCursor, nextTrail);
                }}
                disabled={isSearching || !searchNextCursor}
              >
                Next
              </button>
            </div>
          )}
          {searchError && <p className="error">{searchError}</p>}

          <section className="chat-box" aria-label="Messages">
            {activeScreenShare && activeScreenShare.channelId === activeChannelId && (
              <article className="screen-share-card">
                <header>
                  <strong>{activeScreenShare.presenter.username}</strong>
                  <span className="subtle">is sharing their screen</span>
                </header>
                <video
                  ref={remoteScreenVideoRef}
                  autoPlay
                  muted={activeScreenShare.presenter.userId === auth.user.id}
                  playsInline
                />
              </article>
            )}
            {chatMode === 'channel' && !activeChannelId && (
              <p className="empty">Pick a channel to start chatting.</p>
            )}
            {chatMode === 'dm' && !activeDmThreadId && <p className="empty">Select a DM thread.</p>}
            {((chatMode === 'channel' && activeChannelId) ||
              (chatMode === 'dm' && activeDmThreadId)) &&
              displayedMessages.length === 0 && (
                <p className="empty">
                  {showingSearchResults ? 'No matching messages.' : 'No messages yet.'}
                </p>
              )}
            {displayedMessages.map((message) => (
              <article key={message.id} className="message">
                <header>
                  <strong>{'user' in message ? message.user : message.senderUsername}</strong>
                  <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
                  {'editedAt' in message && message.editedAt && (
                    <span className="subtle">(edited)</span>
                  )}
                </header>
                {'user' in message && editingMessageId === message.id ? (
                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void editMessage(message.id);
                    }}
                  >
                    <input
                      aria-label="Edit message"
                      value={editDraft}
                      maxLength={300}
                      onChange={(event) => setEditDraft(event.target.value)}
                    />
                    <button type="submit">Save</button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingMessageId(null);
                        setEditDraft('');
                      }}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <p>{renderMessageText(message.text, auth.user.username)}</p>
                )}
                {'attachments' in message && message.attachments.length > 0 && (
                  <div className="attachment-grid">
                    {message.attachments.map((attachment) => {
                      const attachmentUrl = `${apiBase}${attachment.url}`;
                      const isClip = attachment.mimeType === 'video/webm' || attachment.fileName.startsWith('highlight-');
                      if (isClip) {
                        return (
                          <article key={attachment.id} className="attachment-card file clip-card">
                            <strong>🎞️ Highlight clip</strong>
                            <video controls preload="metadata" src={attachmentUrl} />
                            <a href={attachmentUrl} target="_blank" rel="noreferrer" download={attachment.fileName}>
                              Download {attachment.fileName}
                            </a>
                          </article>
                        );
                      }

                      return (
                        <a
                          key={attachment.id}
                          className={attachment.category === 'image' ? 'attachment-card image' : 'attachment-card file'}
                          href={attachmentUrl}
                          target="_blank"
                          rel="noreferrer"
                          download={attachment.fileName}
                        >
                          {attachment.category === 'image' ? (
                            <img src={attachmentUrl} alt={attachment.fileName} />
                          ) : (
                            <span className="file-attachment-label">
                              {attachmentIcon(attachment.category)} {attachment.fileName}
                            </span>
                          )}
                        </a>
                      );
                    })}
                  </div>
                )}
                {'user' in message && chatMode === 'channel' && (
                  <div className="message-actions">
                    <button type="button" onClick={() => reportMessage(message.id)}>
                      Report
                    </button>
                    {message.userId === auth.user.id && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMessageId(message.id);
                          setEditDraft(message.text);
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {(message.userId === auth.user.id || isServerOwner) && (
                      <button type="button" onClick={() => deleteMessage(message.id)}>
                        Delete
                      </button>
                    )}
                    {message.userId === null && (
                      <>
                        <button type="button" onClick={() => void copyTextToClipboard(message.id, message.text)}>
                          {copiedAiMessageId === message.id ? 'Copied' : 'Copy'}
                        </button>
                        {aiRequestIdByMessageId[message.id] && (
                          <button type="button" onClick={() => retryAiPrompt(aiRequestIdByMessageId[message.id])}>
                            Retry
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </article>
            ))}

            {shouldShowStreamingAiReply && streamingAiReply && (
              <article className="message" aria-live="polite">
                <header>
                  <strong>{streamingAiReply.botDisplayName}</strong>
                  <span className="subtle">replying…</span>
                </header>
                <p>{streamingAiReply.text || '…'}</p>
              </article>
            )}
          </section>

          {chatMode === 'channel' && (
            <p className="typing-indicator" aria-live="polite">
              {typingUsers.length === 1 && `${typingUsers[0].username} is typing...`}
              {typingUsers.length > 1 &&
                `${typingUsers
                  .slice(0, 2)
                  .map((user) => user.username)
                  .join(
                    ', ',
                  )}${typingUsers.length > 2 ? ` +${typingUsers.length - 2} others` : ''} are typing...`}
              {typingUsers.length === 0 && '\u00A0'}
            </p>
          )}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              sendMessage();
            }}
          >
            <input
              value={draft}
              onChange={(event) => {
                const nextValue = event.target.value;
                setDraft(nextValue);

                if (chatMode !== 'channel') {
                  return;
                }

                const socket = socketRef.current;
                if (!socket || socket.readyState !== WebSocket.OPEN || !activeChannelId) {
                  return;
                }

                if (!nextValue.trim()) {
                  sendTypingStop(activeChannelId);
                  lastSentChannelTextRef.current = nextValue;
                  return;
                }

                if (!isTypingRef.current) {
                  socket.send(
                    JSON.stringify({
                      type: 'typing:start',
                      payload: { channelId: activeChannelId },
                    }),
                  );
                  isTypingRef.current = true;
                }

                queueTypingStop();
              }}
              onBlur={() => sendTypingStop()}
              placeholder={
                chatMode === 'dm'
                  ? activeDmThreadId
                    ? 'Type a DM'
                    : 'Select a DM thread'
                  : activeChannelId
                    ? 'Type a message'
                    : 'Select a channel first'
              }
              aria-label="Message"
              maxLength={300}
            />
            {chatMode === 'channel' && (
              <label className="upload-button">
                Attach
                <input
                  type="file"
                  accept="*/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = '';
                    if (!file) {
                      return;
                    }

                    void uploadAttachment(file);
                  }}
                  hidden
                />
              </label>
            )}
            <button
              type="submit"
              disabled={
                connectionState !== 'open' ||
                (!draft.trim() &&
                  pendingAttachmentUploads.filter((item) => item.status === 'uploaded').length === 0) ||
                (chatMode === 'dm' ? !activeDmThreadId : !activeChannelId)
              }
            >
              Send
            </button>
          </form>
            {chatMode === 'channel' && pendingAttachmentUploads.length > 0 && (
            <div className="attachment-grid pending-uploads">
              {pendingAttachmentUploads.map((item) => (
                <figure key={item.localId}>
                  {item.previewUrl ? (
                    <img src={item.previewUrl} alt={item.fileName} />
                  ) : (
                    <div className="pending-file-icon">{attachmentIcon(item.category)}</div>
                  )}
                  <figcaption>{item.fileName}</figcaption>
                  <figcaption>{item.status === 'failed' ? 'failed' : `${item.progress}%`}</figcaption>
                </figure>
              ))}
            </div>
            )}
          </section>
        </section>

        <aside className="app-rail context-rail">
          <section className="sidebar rail-panel collapsible-panel" data-priority="collapsible">
            <h3>
              AI Settings <span className="panel-priority">collapsible</span>
            </h3>
          {activeServerAiDraft ? (
            <form className="ai-settings-panel" onSubmit={(event) => void saveActiveServerAiSettings(event)}>
              <div className="ai-status-badges">
                <span className={activeServerAiDraft.status.enabled ? 'status-badge success' : 'status-badge'}>enabled</span>
                <span className={activeServerAiDraft.status.keyMissing ? 'status-badge danger' : 'status-badge'}>key missing</span>
                <span className={activeServerAiDraft.status.budgetReached ? 'status-badge danger' : 'status-badge'}>budget reached</span>
                <span className={activeServerAiDraft.status.degradedMode ? 'status-badge warning' : 'status-badge'}>degraded mode</span>
              </div>
              <label>
                <span className="subtle">Enable assistant</span>
                <input
                  type="checkbox"
                  checked={activeServerAiDraft.enabled}
                  disabled={!isServerOwner}
                  onChange={(event) => updateActiveServerAiDraft({ enabled: event.target.checked })}
                />
              </label>
              <label>
                <span className="subtle">Model</span>
                <select
                  value={activeServerAiDraft.model}
                  disabled={!isServerOwner}
                  onChange={(event) => updateActiveServerAiDraft({ model: event.target.value })}
                >
                  {AI_MODEL_OPTIONS.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="subtle">System prompt</span>
                <textarea
                  rows={4}
                  value={activeServerAiDraft.systemPrompt ?? ''}
                  readOnly={!isServerOwner}
                  onChange={(event) =>
                    updateActiveServerAiDraft({
                      systemPrompt: event.target.value.trim().length > 0 ? event.target.value : null,
                    })
                  }
                />
              </label>
              <label>
                <span className="subtle">Temperature</span>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={activeServerAiDraft.temperature ?? 0.7}
                  readOnly={!isServerOwner}
                  onChange={(event) =>
                    updateActiveServerAiDraft({ temperature: Number(event.target.value) || 0 })
                  }
                />
              </label>
              <label>
                <span className="subtle">Max reply length (tokens)</span>
                <input
                  type="number"
                  min={1}
                  value={activeServerAiDraft.maxTokensPerReply ?? 512}
                  readOnly={!isServerOwner}
                  onChange={(event) =>
                    updateActiveServerAiDraft({ maxTokensPerReply: Number(event.target.value) || 1 })
                  }
                />
              </label>
              <label>
                <span className="subtle">Who can invoke AI</span>
                <select
                  value={activeServerAiDraft.invocationPolicy}
                  disabled={!isServerOwner}
                  onChange={(event) =>
                    updateActiveServerAiDraft({ invocationPolicy: event.target.value as AiInvocationPolicy })
                  }
                >
                  <option value="everyone">Everyone</option>
                  <option value="roles">Roles (coming soon)</option>
                </select>
              </label>
              {isServerOwner ? <button type="submit">Save AI settings</button> : <small className="subtle">Owner-only settings</small>}
            </form>
          ) : (
            <p className="subtle">No AI settings loaded.</p>
          )}
          </section>

          <section className="sidebar rail-panel always-visible" data-priority="always-visible">
            <h3>
              Members <span className="panel-priority">always visible</span>
            </h3>
          {isServerOwner && activeServer && (
            <div className="voice-panel-actions">
              <button
                type="button"
                onClick={() =>
                  void authedFetch(`/servers/${activeServer.id}/audio-settings`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      soundboardEnabled: !activeServer.soundboardEnabled,
                      voiceEffectsEnabled: activeServer.voiceEffectsEnabled,
                    }),
                  }).then(async (res) => {
                    if (!res.ok) return;
                    const data = (await res.json()) as { server: ServerSummary };
                    setServers((current) => current.map((entry) => (entry.id === data.server.id ? data.server : entry)));
                  })
                }
              >
                Soundboard: {activeServer.soundboardEnabled ? 'On' : 'Off'}
              </button>
              <button
                type="button"
                onClick={() =>
                  void authedFetch(`/servers/${activeServer.id}/audio-settings`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      soundboardEnabled: activeServer.soundboardEnabled,
                      voiceEffectsEnabled: !activeServer.voiceEffectsEnabled,
                    }),
                  }).then(async (res) => {
                    if (!res.ok) return;
                    const data = (await res.json()) as { server: ServerSummary };
                    setServers((current) => current.map((entry) => (entry.id === data.server.id ? data.server : entry)));
                  })
                }
              >
                Voice effects: {activeServer.voiceEffectsEnabled ? 'On' : 'Off'}
              </button>
            </div>
          )}
          <div className="list members-list">
            {members.map((member) => {
              const isOnline = Boolean(
                activeServerId &&
                (onlineUserIdsByServer[activeServerId] ?? []).includes(member.userId),
              );
              return (
                <div key={member.userId} className="member-row">
                  <span
                    className={isOnline ? 'presence-dot online' : 'presence-dot offline'}
                    aria-hidden="true"
                  />
                  <span>{member.username}</span>
                  <small className="subtle">{member.role}</small>
                  {!member.canShareScreen && <small className="subtle">no-share</small>}
                  {isServerOwner && member.userId !== auth.user.id && (
                    <>
                      {member.isMuted ? (
                        <button type="button" onClick={() => unmuteMember(member.userId)}>
                          Unmute
                        </button>
                      ) : (
                        <button type="button" onClick={() => muteMember(member.userId)}>
                          Mute
                        </button>
                      )}
                      <label className="subtle">
                        <input
                          type="checkbox"
                          checked={member.canShareScreen}
                          onChange={(event) =>
                            void updateMemberPermission(member.userId, event.target.checked)
                          }
                        />
                        can-share
                      </label>
                    </>
                  )}
                </div>
              );
            })}
            {members.length === 0 && <p className="empty">No members yet.</p>}
          </div>
          </section>

          <details className="sidebar rail-panel advanced-panel" data-priority="advanced" open={false}>
            <summary>
              Diagnostics & status internals <span className="panel-priority">advanced</span>
            </summary>
            <section className="notification-settings rail-stack">
              <label>
                <input
                  type="checkbox"
                  checked={desktopNotificationsEnabled}
                  onChange={(event) => {
                    void toggleDesktopNotifications(event.target.checked);
                  }}
                />
                Enable desktop notifications
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={spatialAudioEnabled}
                  disabled={!spatialAudioAvailable}
                  onChange={(event) => setSpatialAudioEnabled(event.target.checked)}
                />
                Enable spatial audio
              </label>
              <small className="subtle">Permission: {notificationPermission}</small>
              {!spatialAudioAvailable && (
                <small className="subtle">Spatial audio unavailable in this browser.</small>
              )}
            </section>
            <div className="list">
              {auditLogs.map((log) => (
                <div key={log.id} className="member-row">
                  <span>{log.action}</span>
                  <small className="subtle">{log.actorUsername}</small>
                </div>
              ))}
              {auditLogs.length === 0 && <p className="empty">No moderation events.</p>}
            </div>
          </details>
        </aside>
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
