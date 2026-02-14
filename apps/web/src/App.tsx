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
  type ServerSummary,
  type StreamType,
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
    | 'screen_share_start'
    | 'screen_share_stop'
    | 'screen_share_force_stop';
  details: unknown;
  createdAt: string;
};

type PendingImageUpload = {
  localId: string;
  fileName: string;
  previewUrl: string;
  attachmentId: string;
};

type PeerConnectionHealth = 'connecting' | 'connected' | 'failed' | 'restarting';

type VoiceRuntimeMetrics = {
  joinAttempts: number;
  joinSuccesses: number;
  setupDurationsMs: number[];
  disconnectCauses: Record<string, number>;
};

const AUTH_STORAGE_KEY = 'curly_broccoli_auth';
const DESKTOP_NOTIFICATIONS_STORAGE_KEY = 'curly_broccoli_desktop_notifications_enabled';
const TYPING_STOP_DELAY_MS = 1200;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 12_000;

type NotificationPermissionState = 'unsupported' | NotificationPermission;

type MentionSegment = {
  text: string;
  mentioned: boolean;
};

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

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read file.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const encoded = result.includes(',') ? result.split(',')[1] : '';
      resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

export function App() {
  const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
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
  const speakingIntervalRef = useRef<number | null>(null);
  const localSpeakingAnalyserRef = useRef<AnalyserNode | null>(null);
  const localSpeakingDataRef = useRef<Uint8Array | null>(null);
  const remoteSpeakingAnalyserByUserIdRef = useRef<Map<string, AnalyserNode>>(new Map());
  const remoteSpeakingDataByUserIdRef = useRef<Map<string, Uint8Array>>(new Map());
  const localScreenStreamRef = useRef<MediaStream | null>(null);
  const screenPeerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteScreenVideoRef = useRef<HTMLVideoElement | null>(null);

  const [auth, setAuth] = useState<AuthState | null>(() => loadAuthState());
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [systemMessage, setSystemMessage] = useState('Sign in to join chat.');
  const [error, setError] = useState<string | null>(null);
  const [auditLogs, setAuditLogs] = useState<ModerationAuditLog[]>([]);

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
  const [pendingImageUploads, setPendingImageUploads] = useState<PendingImageUpload[]>([]);
  const [channelUnreadCounts, setChannelUnreadCounts] = useState<Record<string, number>>({});
  const [dmUnreadCounts, setDmUnreadCounts] = useState<Record<string, number>>({});
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] = useState(() =>
    loadDesktopNotificationsEnabled(),
  );
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
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<(ChatMessage | DmMessage)[]>([]);
  const [searchOffset, setSearchOffset] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const SEARCH_PAGE_SIZE = 20;

  const visibleMessages = chatMode === 'dm' ? dmMessages : messages;
  const showingSearchResults = searchQuery.trim().length > 0;
  const displayedMessages = showingSearchResults ? searchResults : visibleMessages;
  const currentMember = members.find((member) => member.userId === auth?.user.id) ?? null;
  const isServerOwner = currentMember?.role === 'owner';
  const totalChannelUnread = Object.values(channelUnreadCounts).reduce(
    (sum, value) => sum + value,
    0,
  );
  const totalDmUnread = Object.values(dmUnreadCounts).reduce((sum, value) => sum + value, 0);

  useEffect(() => {
    activeChannelRef.current = activeChannelId;
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
      audio.volume = (outputVolumeByUserId[userId] ?? 100) / 100;
    }
  }, [outputVolumeByUserId]);

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
        localAnalyser.getByteTimeDomainData(localData);
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
        analyser.getByteTimeDomainData(data);
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
        peerConnection.addTrack(track, stream);
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
    localSpeakingAnalyserRef.current = null;
    localSpeakingDataRef.current = null;
    void localAudioContextRef.current?.close();
    localAudioContextRef.current = null;
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
    source.connect(gainNode);
    gainNode.connect(analyser);

    const destination = context.createMediaStreamDestination();
    gainNode.connect(destination);

    localGainNodeRef.current = gainNode;
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
      audio.volume = (outputVolumeByUserId[targetUserId] ?? 100) / 100;

      if (remoteAudioContextRef.current) {
        const source = remoteAudioContextRef.current.createMediaStreamSource(remoteStream);
        const analyser = remoteAudioContextRef.current.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        remoteSpeakingAnalyserByUserIdRef.current.set(targetUserId, analyser);
        remoteSpeakingDataByUserIdRef.current.set(targetUserId, new Uint8Array(analyser.fftSize));
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

  useEffect(() => {
    if (!auth) {
      setConnectionState('closed');
      setMessages([]);
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
      setPendingImageUploads([]);
      setChannelUnreadCounts({});
      setDmUnreadCounts({});
      setSearchQuery('');
      setSearchResults([]);
      setSearchOffset(0);
      setSearchError(null);
      return;
    }

    void Promise.all([loadServers(), loadDmThreads()]).catch((reason: unknown) => {
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

      if (parsed.type === 'system') {
        setSystemMessage(parsed.payload.text);
      }

      if (parsed.type === 'voice:participants') {
        voiceMetricsRef.current.joinSuccesses += 1;
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

          if (description) {
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

      if (parsed.type === 'voice:signal') {
        const { channelId, fromUserId, description, candidate } = parsed.payload;
        void (async () => {
          const peerConnection = await createPeerConnection(fromUserId, channelId, false);
          if (!peerConnection) {
            return;
          }

          if (description) {
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
          const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1));
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
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeChannelId) {
      return;
    }

    setPendingImageUploads([]);
    setMessages([]);
    setSearchQuery('');
    setSearchResults([]);
    setSearchOffset(0);
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
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeDmThreadId) {
      return;
    }

    setDmMessages([]);
    setSearchQuery('');
    setSearchResults([]);
    setSearchOffset(0);
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

  async function runSearch(offset = 0) {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchOffset(0);
      setSearchError(null);
      return;
    }

    const path =
      chatMode === 'dm'
        ? `/dm/messages/search?threadId=${encodeURIComponent(String(activeDmThreadId ?? ''))}&query=${encodeURIComponent(query)}&limit=${SEARCH_PAGE_SIZE}&offset=${offset}`
        : `/messages/search?channelId=${encodeURIComponent(String(activeChannelId ?? ''))}&query=${encodeURIComponent(query)}&limit=${SEARCH_PAGE_SIZE}&offset=${offset}`;

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

      const data = (await res.json()) as { messages: (ChatMessage | DmMessage)[] };
      setSearchResults(data.messages);
      setSearchOffset(offset);
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

      socket.send(JSON.stringify({ type: 'screen:share-start', payload: { channelId: activeChannelId } }));
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
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        payload: {
          text,
          attachmentIds: pendingImageUploads.map((item) => item.attachmentId),
        },
      }),
    );
    setDraft('');
    setPendingImageUploads([]);
    setError(null);
  }

  async function uploadImage(file: File) {
    if (!activeChannelId) {
      setError('Select a channel before uploading images.');
      return;
    }

    const base64Data = await fileToBase64(file);

    const res = await authedFetch('/uploads/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: activeChannelId,
        fileName: file.name,
        mimeType: file.type,
        fileDataBase64: base64Data,
      }),
    });

    if (!res.ok) {
      setError('Unable to upload image.');
      return;
    }

    const data = (await res.json()) as { attachment: { id: string } };
    setPendingImageUploads((prev) => [
      ...prev,
      {
        localId: crypto.randomUUID(),
        fileName: file.name,
        previewUrl: URL.createObjectURL(file),
        attachmentId: data.attachment.id,
      },
    ]);
    setError(null);
  }

  async function submitAuthForm(event: FormEvent) {
    event.preventDefault();

    const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
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

    await loadAuditLogs(activeServerId);
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

      <section className="notification-settings">
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
        <small className="subtle">Permission: {notificationPermission}</small>
      </section>

      <section className="guild-shell">
        <aside className="sidebar">
          <h3>Servers</h3>
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
        </aside>

        <aside className="sidebar">
          <h3>Channels {totalChannelUnread > 0 ? `(${totalChannelUnread})` : ''}</h3>
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
        </aside>

        <aside className="sidebar">
          <h3>Direct Messages {totalDmUnread > 0 ? `(${totalDmUnread})` : ''}</h3>
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
        </aside>

        <section className="chat-panel">
          <section className="voice-panel">
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

          <div className="share-consent-card">
            <p className="subtle">
              Browser consent: <strong>{screenConsentState}</strong> · In-app consent:{' '}
              <strong>{activeScreenShare ? 'active' : 'not sharing'}</strong>
            </p>
            {screenShareScopeWarning && <p className="subtle">{screenShareScopeWarning}</p>}
            {(currentMember ? !currentMember.canShareScreen : false) && (
              <p className="subtle">Role gate active: you do not have the "Can share screen" permission.</p>
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
          <div className="voice-controls">
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
          <div className="voice-participants">
            {voiceParticipants
              .filter((participant) => participant.userId !== auth.user.id)
              .map((participant) => (
                <span key={participant.userId} className="voice-chip">
                  {participant.username}
                  <strong className="voice-state">{peerStateByUserId[participant.userId] ?? 'connecting'}</strong>
                  {speakingByUserId[participant.userId] && <span className="speaking-dot" aria-label="speaking" />}
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
          <form
            className="inline-form search-bar"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(0);
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
                  setSearchOffset(0);
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
                onClick={() => void runSearch(Math.max(0, searchOffset - SEARCH_PAGE_SIZE))}
                disabled={isSearching || searchOffset === 0}
              >
                Previous
              </button>
              <span className="subtle">Offset {searchOffset}</span>
              <button
                type="button"
                onClick={() => void runSearch(searchOffset + SEARCH_PAGE_SIZE)}
                disabled={isSearching || searchResults.length < SEARCH_PAGE_SIZE}
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
                <video ref={remoteScreenVideoRef} autoPlay muted={activeScreenShare.presenter.userId === auth.user.id} playsInline />
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
                </header>
                <p>{renderMessageText(message.text, auth.user.username)}</p>
                {'attachments' in message && message.attachments.length > 0 && (
                  <div className="attachment-grid">
                    {message.attachments.map((attachment) => (
                      <a
                        key={attachment.id}
                        href={`${apiBase}${attachment.url}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img src={`${apiBase}${attachment.url}`} alt={attachment.fileName} />
                      </a>
                    ))}
                  </div>
                )}
                {'user' in message && chatMode === 'channel' && (
                  <div className="message-actions">
                    <button type="button" onClick={() => reportMessage(message.id)}>
                      Report
                    </button>
                    {(message.userId === auth.user.id || isServerOwner) && (
                      <button type="button" onClick={() => deleteMessage(message.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
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
                Image
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = '';
                    if (!file) {
                      return;
                    }

                    void uploadImage(file);
                  }}
                  hidden
                />
              </label>
            )}
            <button
              type="submit"
              disabled={
                connectionState !== 'open' ||
                (!draft.trim() && pendingImageUploads.length === 0) ||
                (chatMode === 'dm' ? !activeDmThreadId : !activeChannelId)
              }
            >
              Send
            </button>
          </form>
          {chatMode === 'channel' && pendingImageUploads.length > 0 && (
            <div className="attachment-grid pending-uploads">
              {pendingImageUploads.map((item) => (
                <figure key={item.localId}>
                  <img src={item.previewUrl} alt={item.fileName} />
                  <figcaption>{item.fileName}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>

        <aside className="sidebar">
          <h3>Members</h3>
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
                    <button type="button" onClick={() => muteMember(member.userId)}>
                      Mute
                    </button>
                  )}
                </div>
              );
            })}
            {members.length === 0 && <p className="empty">No members yet.</p>}
          </div>
          <h3>Audit Log</h3>
          <div className="list">
            {auditLogs.map((log) => (
              <div key={log.id} className="member-row">
                <span>{log.action}</span>
                <small className="subtle">{log.actorUsername}</small>
              </div>
            ))}
            {auditLogs.length === 0 && <p className="empty">No moderation events.</p>}
          </div>
        </aside>
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
