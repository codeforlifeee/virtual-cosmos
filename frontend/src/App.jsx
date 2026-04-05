import { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import * as PIXI from 'pixi.js'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000'
const SPEED = 280
const HATS = ['none', 'cap', 'halo', 'wizard']
const BADGES = ['none', 'star', 'helper', 'captain']
const EMOTE_OPTIONS = ['wave', 'thumbs', 'laugh']
const EMOTE_LABELS = {
  wave: '👋',
  thumbs: '👍',
  laugh: '😂',
}
const EMOTE_BUTTON_LABELS = {
  wave: '👋 Wave',
  thumbs: '👍 Thumbs Up',
  laugh: '😂 Laugh',
}

const MOVEMENT_KEYS = {
  w: [0, -1],
  a: [-1, 0],
  s: [0, 1],
  d: [1, 0],
  arrowup: [0, -1],
  arrowleft: [-1, 0],
  arrowdown: [0, 1],
  arrowright: [1, 0],
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const toUserMap = (list) => Object.fromEntries((list || []).map((user) => [user.id, user]))

const hexToNumber = (hex, fallback = 0x34d399) => {
  const normalized = String(hex || '').replace('#', '')
  const parsed = Number.parseInt(normalized, 16)
  return Number.isNaN(parsed) ? fallback : parsed
}

const readJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) {
      return fallback
    }

    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

const safeRoomId = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 32)

  return normalized || 'lobby'
}

const toMediaErrorMessage = (error) => {
  const name = String(error?.name || 'UnknownError')
  if (name === 'NotAllowedError') {
    return 'Camera/microphone permission was denied by the browser.'
  }

  if (name === 'NotFoundError') {
    return 'No camera device was found on this laptop.'
  }

  if (name === 'NotReadableError') {
    return 'Camera is in use by another app (Zoom, Meet, Teams, etc.).'
  }

  if (name === 'OverconstrainedError') {
    return 'Requested camera settings are not supported on this device.'
  }

  return 'Unable to access camera/microphone on this device.'
}

function App() {
  const [savedPrefs] = useState(() => readJson('cosmos-preferences', {}))
  const [savedPosition] = useState(() => readJson('cosmos-last-position', null))

  const [joined, setJoined] = useState(false)
  const [displayName, setDisplayName] = useState(savedPrefs.displayName || `Cosmo-${Math.floor(Math.random() * 900 + 100)}`)
  const [roomId, setRoomId] = useState(savedPrefs.roomId || 'lobby')
  const [avatarColor, setAvatarColor] = useState(savedPrefs.avatarColor || '#34d399')
  const [hat, setHat] = useState(savedPrefs.hat || 'none')
  const [badge, setBadge] = useState(savedPrefs.badge || 'none')

  const [socketOnline, setSocketOnline] = useState(false)
  const [connectionLabel, setConnectionLabel] = useState('Waiting')
  const [selfId, setSelfId] = useState('')
  const [worldConfig, setWorldConfig] = useState({
    worldWidth: 1600,
    worldHeight: 900,
    proximityRadius: 190,
    zones: [],
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })

  const [users, setUsers] = useState({})
  const [connectedUserIds, setConnectedUserIds] = useState([])
  const [currentZoneId, setCurrentZoneId] = useState(null)
  const [zoneNotice, setZoneNotice] = useState('')

  const [activeChatId, setActiveChatId] = useState('')
  const [messagesByUser, setMessagesByUser] = useState({})
  const [draftMessage, setDraftMessage] = useState('')
  const [activeEmotes, setActiveEmotes] = useState({})

  const [blockedUserKeys, setBlockedUserKeys] = useState([])
  const [mutedUserKeys, setMutedUserKeys] = useState([])
  const [reportReason, setReportReason] = useState('spam')
  const [reportDetails, setReportDetails] = useState('')
  const [reportAck, setReportAck] = useState('')

  const [activeVoicePeerId, setActiveVoicePeerId] = useState('')
  const [activeCallMode, setActiveCallMode] = useState('none')
  const [remoteVideoStream, setRemoteVideoStream] = useState(null)
  const [voiceError, setVoiceError] = useState('')

  const socketRef = useRef(null)
  const usersRef = useRef({})
  const keyStateRef = useRef(new Set())
  const hostRef = useRef(null)
  const appRef = useRef(null)
  const worldRef = useRef(null)
  const arenaRef = useRef(null)
  const zonesLayerRef = useRef(null)
  const zoneLabelsRef = useRef(null)
  const avatarsRef = useRef(new Map())
  const selfIdRef = useRef('')
  const activeVoicePeerIdRef = useRef('')
  const emoteTimeoutsRef = useRef(new Map())
  const peerConnectionsRef = useRef(new Map())
  const remoteAudioElsRef = useRef(new Map())
  const remoteVideoStreamsRef = useRef(new Map())
  const localStreamRef = useRef(null)
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const connectedUserIdsRef = useRef([])
  const zoneMapRef = useRef({})
  const lastLocalMoveAtRef = useRef(0)

  const setUsersSafe = (updater) => {
    setUsers((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      usersRef.current = next
      return next
    })
  }

  const selfUser = users[selfId]
  const connectedUsers = useMemo(() => connectedUserIds.map((id) => users[id]).filter(Boolean), [connectedUserIds, users])
  const selectedUser = activeChatId ? users[activeChatId] : null
  const chatMessages = activeChatId ? messagesByUser[activeChatId] || [] : []
  const zoneMap = useMemo(
    () => Object.fromEntries((worldConfig.zones || []).map((zone) => [zone.id, zone])),
    [worldConfig.zones],
  )
  const currentZone = currentZoneId ? zoneMap[currentZoneId] : null
  const zoneCounts = useMemo(() => {
    const counts = {}
    for (const user of Object.values(users)) {
      if (!user.zoneId) {
        continue
      }

      counts[user.zoneId] = (counts[user.zoneId] || 0) + 1
    }

    return counts
  }, [users])

  const selectedUserMuted = Boolean(selectedUser && mutedUserKeys.includes(selectedUser.userId))
  const selectedUserBlocked = Boolean(selectedUser && blockedUserKeys.includes(selectedUser.userId))

  useEffect(() => {
    usersRef.current = users
  }, [users])

  useEffect(() => {
    selfIdRef.current = selfId
  }, [selfId])

  useEffect(() => {
    activeVoicePeerIdRef.current = activeVoicePeerId
  }, [activeVoicePeerId])

  useEffect(() => {
    connectedUserIdsRef.current = connectedUserIds
  }, [connectedUserIds])

  useEffect(() => {
    zoneMapRef.current = zoneMap
  }, [zoneMap])

  useEffect(() => {
    localStorage.setItem(
      'cosmos-preferences',
      JSON.stringify({
        displayName,
        roomId,
        avatarColor,
        hat,
        badge,
      }),
    )
  }, [avatarColor, badge, displayName, hat, roomId])

  useEffect(() => {
    if (!selfUser) {
      return
    }

    localStorage.setItem(
      'cosmos-last-position',
      JSON.stringify({
        x: selfUser.x,
        y: selfUser.y,
      }),
    )
  }, [selfUser])

  useEffect(() => {
    if (!connectedUserIds.length) {
      setActiveChatId('')
      return
    }

    if (!activeChatId || !connectedUserIds.includes(activeChatId)) {
      setActiveChatId(connectedUserIds[0])
    }
  }, [activeChatId, connectedUserIds])

  useEffect(() => {
    if (!zoneNotice) {
      return
    }

    const timer = window.setTimeout(() => setZoneNotice(''), 1800)
    return () => window.clearTimeout(timer)
  }, [zoneNotice])

  const showEmote = (userId, emote) => {
    setActiveEmotes((prev) => ({
      ...prev,
      [userId]: emote,
    }))

    const previous = emoteTimeoutsRef.current.get(userId)
    if (previous) {
      window.clearTimeout(previous)
    }

    const timer = window.setTimeout(() => {
      setActiveEmotes((prev) => {
        const next = { ...prev }
        delete next[userId]
        return next
      })
      emoteTimeoutsRef.current.delete(userId)
    }, 1600)

    emoteTimeoutsRef.current.set(userId, timer)
  }

  const closeVoicePeer = (peerId, notifyPeer = false) => {
    const socket = socketRef.current
    if (notifyPeer && socket) {
      socket.emit('voice:hangup', { toUserId: peerId })
    }

    const pc = peerConnectionsRef.current.get(peerId)
    if (pc) {
      pc.close()
      peerConnectionsRef.current.delete(peerId)
    }

    const audio = remoteAudioElsRef.current.get(peerId)
    if (audio) {
      audio.pause()
      audio.srcObject = null
      remoteAudioElsRef.current.delete(peerId)
    }

    remoteVideoStreamsRef.current.delete(peerId)
    if (activeVoicePeerId === peerId) {
      setRemoteVideoStream(null)
    }

    if (activeVoicePeerId === peerId) {
      setActiveVoicePeerId('')
      setActiveCallMode('none')
    }
  }

  const closeAllVoice = () => {
    for (const peerId of Array.from(peerConnectionsRef.current.keys())) {
      closeVoicePeer(peerId, false)
    }

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop()
      }
      localStreamRef.current = null
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }

    remoteVideoStreamsRef.current.clear()
    setRemoteVideoStream(null)

    setActiveVoicePeerId('')
    setActiveCallMode('none')
  }

  const ensureLocalMedia = async ({ video = false } = {}) => {
    if (localStreamRef.current) {
      const hasVideo = localStreamRef.current.getVideoTracks().length > 0
      if ((video && hasVideo) || (!video && !hasVideo)) {
        return localStreamRef.current
      }

      for (const track of localStreamRef.current.getTracks()) {
        track.stop()
      }
      localStreamRef.current = null
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('MediaDevicesUnavailable')
    }

    let stream
    if (video) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: true,
        })
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      })
    }

    localStreamRef.current = stream

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = video ? stream : null
      if (video) {
        localVideoRef.current.play().catch(() => {})
      }
    }

    return stream
  }

  const createPeerConnection = async (peerId) => {
    let existing = peerConnectionsRef.current.get(peerId)
    if (existing) {
      return existing
    }

    const socket = socketRef.current
    const pc = new RTCPeerConnection({ iceServers: worldConfig.iceServers || [] })

    pc.onicecandidate = (event) => {
      if (!event.candidate || !socket) {
        return
      }

      socket.emit('voice:ice-candidate', {
        toUserId: peerId,
        candidate: event.candidate,
      })
    }

    pc.ontrack = (event) => {
      const stream = event.streams?.[0]
      if (!stream) {
        return
      }

      if (stream.getAudioTracks().length > 0) {
      let audio = remoteAudioElsRef.current.get(peerId)
      if (!audio) {
        audio = new Audio()
        audio.autoplay = true
        remoteAudioElsRef.current.set(peerId, audio)
      }

      audio.srcObject = stream
      audio.play().catch(() => {})
      }

      if (stream.getVideoTracks().length > 0) {
        remoteVideoStreamsRef.current.set(peerId, stream)
        if (activeVoicePeerIdRef.current === peerId) {
          setRemoteVideoStream(stream)
        }
      }
    }

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        closeVoicePeer(peerId, false)
      }
    }

    const localStream = localStreamRef.current
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream)
      }
    }

    peerConnectionsRef.current.set(peerId, pc)
    existing = pc
    return existing
  }

  const startCall = async (peerId, mode) => {
    if (!peerId || !connectedUserIds.includes(peerId)) {
      return
    }

    try {
      await ensureLocalMedia({ video: mode === 'video' })
      const pc = await createPeerConnection(peerId)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      socketRef.current?.emit('voice:offer', {
        toUserId: peerId,
        sdp: offer,
      })

      setActiveVoicePeerId(peerId)
      setActiveCallMode(mode)
      setVoiceError('')
    } catch (error) {
      setVoiceError(toMediaErrorMessage(error))
      setActiveVoicePeerId('')
      setActiveCallMode('none')
    }
  }

  const startVoiceCall = async (peerId) => {
    await startCall(peerId, 'voice')
  }

  const startVideoCall = async (peerId) => {
    await startCall(peerId, 'video')
  }

  useEffect(() => {
    if (!joined) {
      return undefined
    }

    const storedUserKey = localStorage.getItem('cosmos-user-key') || crypto.randomUUID()
    localStorage.setItem('cosmos-user-key', storedUserKey)

    const socket = io(SOCKET_URL, {
      reconnection: true,
      reconnectionDelay: 800,
      auth: {
        name: displayName.trim() || 'Cosmonaut',
        roomId,
        userKey: storedUserKey,
        avatarColor,
        hat,
        badge,
        lastX: savedPosition?.x,
        lastY: savedPosition?.y,
      },
    })

    socketRef.current = socket
    setConnectionLabel('Connecting...')

    socket.on('connect', () => {
      setSocketOnline(true)
      setConnectionLabel('Realtime Connected')
    })

    socket.on('disconnect', (reason) => {
      setSocketOnline(false)
      setConnectedUserIds([])
      setConnectionLabel(reason === 'io client disconnect' ? 'Disconnected' : 'Reconnecting...')
      closeAllVoice()
    })

    socket.io.on('reconnect_attempt', (attempt) => {
      setConnectionLabel(`Reconnecting (${attempt})`)
    })

    socket.io.on('reconnect', () => {
      setConnectionLabel('Reconnected')
      setSocketOnline(true)
    })

    socket.on('world:init', (payload) => {
      setSelfId(payload.selfId)
      setWorldConfig((prev) => ({
        ...prev,
        ...payload.config,
        iceServers:
          Array.isArray(payload.config?.iceServers) && payload.config.iceServers.length
            ? payload.config.iceServers
            : prev.iceServers,
      }))
          setRoomId(payload.config?.roomId || roomId)

      const mapped = toUserMap(payload.users)
      setUsersSafe(mapped)
      const me = mapped[payload.selfId]
      setCurrentZoneId(me?.zoneId || null)
    })

    socket.on('world:user-joined', (user) => {
      setUsersSafe((prev) => ({
        ...prev,
        [user.id]: user,
      }))
    })

    socket.on('world:user-updated', (user) => {
      setUsersSafe((prev) => ({
        ...prev,
        [user.id]: {
          ...(prev[user.id] || {}),
          ...user,
        },
      }))
    })

    socket.on('world:user-moved', (user) => {
      const isSelf = user.id === selfIdRef.current
      const hasPressedMovementKey = keyStateRef.current.size > 0
      const isRecentPredictedMove = performance.now() - lastLocalMoveAtRef.current < 140

      if (isSelf && hasPressedMovementKey && isRecentPredictedMove) {
        setUsersSafe((prev) => ({
          ...prev,
          [user.id]: {
            ...(prev[user.id] || {}),
            ...user,
            x: prev[user.id]?.x ?? user.x,
            y: prev[user.id]?.y ?? user.y,
          },
        }))

        setCurrentZoneId(user.zoneId || null)
        return
      }

      setUsersSafe((prev) => ({
        ...prev,
        [user.id]: {
          ...(prev[user.id] || {}),
          ...user,
        },
      }))

      if (user.id === selfIdRef.current) {
        setCurrentZoneId(user.zoneId || null)
      }
    })

    socket.on('world:user-left', ({ id }) => {
      setUsersSafe((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })

      setConnectedUserIds((prev) => prev.filter((value) => value !== id))
      setMessagesByUser((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      closeVoicePeer(id, false)
    })

    socket.on('zone:changed', ({ zoneId }) => {
      setCurrentZoneId(zoneId || null)
      if (zoneId && zoneMapRef.current[zoneId]) {
        setZoneNotice(`Entered ${zoneMapRef.current[zoneId].name}`)
      } else {
        setZoneNotice('Left named zone')
      }
    })

    socket.on('proximity:snapshot', (payload) => {
      setConnectedUserIds(payload.connectedUserIds || [])
    })

    socket.on('chat:message', (payload) => {
      const me = selfIdRef.current
      const peerId = payload.fromId === me ? payload.toId : payload.fromId

      setMessagesByUser((prev) => ({
        ...prev,
        [peerId]: [...(prev[peerId] || []), payload],
      }))
    })

    socket.on('emote:show', (payload) => {
      showEmote(payload.fromId, payload.emote)
    })

    socket.on('moderation:state', (payload) => {
      setBlockedUserKeys(payload.blockedUserKeys || [])
      setMutedUserKeys(payload.mutedUserKeys || [])
    })

    socket.on('moderation:report:ack', (payload) => {
      const target = usersRef.current[payload.targetUserId]
      const targetName = target?.name || 'user'
      setReportAck(`Report submitted for ${targetName} (${payload.reason}).`)
      setReportDetails('')
    })

    socket.on('voice:offer', async ({ fromId, sdp }) => {
      if (!connectedUserIdsRef.current.includes(fromId)) {
        return
      }

      try {
        const hasVideo = String(sdp?.sdp || '').includes('m=video')
        await ensureLocalMedia({ video: hasVideo })
        const pc = await createPeerConnection(fromId)
        await pc.setRemoteDescription(new RTCSessionDescription(sdp))

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        socket.emit('voice:answer', {
          toUserId: fromId,
          sdp: answer,
        })

        setActiveVoicePeerId(fromId)
        setActiveCallMode(hasVideo ? 'video' : 'voice')
        if (!hasVideo) {
          setRemoteVideoStream(null)
        }
        setVoiceError('')
      } catch (error) {
        setVoiceError(toMediaErrorMessage(error))
      }
    })

    socket.on('voice:answer', async ({ fromId, sdp }) => {
      const pc = peerConnectionsRef.current.get(fromId)
      if (!pc) {
        return
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp))
        const hasVideo = String(sdp?.sdp || '').includes('m=video')
        setActiveCallMode(hasVideo ? 'video' : 'voice')
      } catch {
        setVoiceError('Call answer could not be applied.')
      }
    })

    socket.on('voice:ice-candidate', async ({ fromId, candidate }) => {
      try {
        const pc = await createPeerConnection(fromId)
        await pc.addIceCandidate(candidate)
      } catch {
        setVoiceError('Call candidate sync failed.')
      }
    })

    socket.on('voice:hangup', ({ fromId }) => {
      closeVoicePeer(fromId, false)
    })

    return () => {
      closeAllVoice()
      socket.disconnect()
      socketRef.current = null
    }
  }, [avatarColor, badge, displayName, hat, joined, roomId])

  useEffect(() => {
    if (!activeVoicePeerId) {
      return
    }

    if (!connectedUserIds.includes(activeVoicePeerId)) {
      closeVoicePeer(activeVoicePeerId, true)
      setVoiceError('Call ended because proximity was lost.')
    }
  }, [activeVoicePeerId, connectedUserIds])

  useEffect(() => {
    if (!remoteVideoRef.current) {
      return
    }

    remoteVideoRef.current.srcObject = remoteVideoStream || null
    if (remoteVideoStream) {
      remoteVideoRef.current.play().catch(() => {})
    }
  }, [remoteVideoStream])

  useEffect(() => {
    if (!activeVoicePeerId) {
      setRemoteVideoStream(null)
      return
    }

    setRemoteVideoStream(remoteVideoStreamsRef.current.get(activeVoicePeerId) || null)
  }, [activeVoicePeerId])

  useEffect(() => {
    if (!activeVoicePeerId || !selfUser) {
      return
    }

    const peer = users[activeVoicePeerId]
    const audio = remoteAudioElsRef.current.get(activeVoicePeerId)
    if (!peer || !audio) {
      return
    }

    const dx = selfUser.x - peer.x
    const dy = selfUser.y - peer.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const attenuation = clamp(1 - dist / worldConfig.proximityRadius, 0, 1)
    const muted = mutedUserKeys.includes(peer.userId)
    audio.volume = muted ? 0 : attenuation * attenuation
  }, [activeVoicePeerId, mutedUserKeys, selfUser, users, worldConfig.proximityRadius])

  useEffect(() => {
    if (!joined) {
      return
    }

    const clearMovementKeys = () => {
      keyStateRef.current.clear()
    }

    const onKeyDown = (event) => {
      const key = event.key.toLowerCase()
      if (!MOVEMENT_KEYS[key]) {
        return
      }

      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          return
        }
      }

      event.preventDefault()
      keyStateRef.current.add(key)
    }

    const onKeyUp = (event) => {
      keyStateRef.current.delete(event.key.toLowerCase())
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        clearMovementKeys()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clearMovementKeys)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clearMovementKeys)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      clearMovementKeys()
    }
  }, [joined])

  useEffect(() => {
    if (!joined || !selfId) {
      return
    }

    let animationFrameId = 0
    let previousTime = performance.now()
    let lastSentAt = 0

    const step = (now) => {
      const delta = Math.min((now - previousTime) / 1000, 0.05)
      previousTime = now

      const me = usersRef.current[selfIdRef.current]
      if (me) {
        let axisX = 0
        let axisY = 0

        for (const key of keyStateRef.current) {
          axisX += MOVEMENT_KEYS[key][0]
          axisY += MOVEMENT_KEYS[key][1]
        }

        if (axisX !== 0 || axisY !== 0) {
          const mag = Math.sqrt(axisX * axisX + axisY * axisY) || 1
          const nextX = clamp(me.x + (axisX / mag) * SPEED * delta, 0, worldConfig.worldWidth)
          const nextY = clamp(me.y + (axisY / mag) * SPEED * delta, 0, worldConfig.worldHeight)
          lastLocalMoveAtRef.current = now

          setUsersSafe((prev) => {
            const existing = prev[selfIdRef.current]
            if (!existing) {
              return prev
            }

            return {
              ...prev,
              [selfIdRef.current]: {
                ...existing,
                x: nextX,
                y: nextY,
              },
            }
          })

          if (now - lastSentAt > 45) {
            socketRef.current?.emit('player:move', {
              x: nextX,
              y: nextY,
            })
            lastSentAt = now
          }
        }
      }

      animationFrameId = requestAnimationFrame(step)
    }

    animationFrameId = requestAnimationFrame(step)

    return () => cancelAnimationFrame(animationFrameId)
  }, [joined, selfId, worldConfig.worldHeight, worldConfig.worldWidth])

  useEffect(() => {
    if (!joined || !hostRef.current) {
      return
    }

    let cancelled = false

    const drawArena = () => {
      const app = appRef.current
      const world = worldRef.current
      const arena = arenaRef.current
      const zonesLayer = zonesLayerRef.current
      const zoneLabels = zoneLabelsRef.current

      if (!app || !world || !arena || !zonesLayer || !zoneLabels) {
        return
      }

      const screenW = app.renderer.width
      const screenH = app.renderer.height
      const padding = 18
      const ratio = Math.min(
        (screenW - padding * 2) / worldConfig.worldWidth,
        (screenH - padding * 2) / worldConfig.worldHeight,
      )
      const snappedRatio = Math.round(ratio * 1000) / 1000

      world.scale.set(snappedRatio)
      world.position.set(
        Math.round((screenW - worldConfig.worldWidth * snappedRatio) / 2),
        Math.round((screenH - worldConfig.worldHeight * snappedRatio) / 2),
      )

      arena.clear()
      arena.beginFill(0xe6edf4, 1)
      arena.drawRoundedRect(0, 0, worldConfig.worldWidth, worldConfig.worldHeight, 24)
      arena.endFill()
      arena.lineStyle(3, 0x2f4963, 0.55)
      arena.drawRoundedRect(0, 0, worldConfig.worldWidth, worldConfig.worldHeight, 24)

      arena.lineStyle(1, 0x94a7bb, 0.45)
      for (let x = 80; x < worldConfig.worldWidth; x += 80) {
        arena.moveTo(x + 0.5, 0)
        arena.lineTo(x + 0.5, worldConfig.worldHeight)
      }

      for (let y = 80; y < worldConfig.worldHeight; y += 80) {
        arena.moveTo(0, y + 0.5)
        arena.lineTo(worldConfig.worldWidth, y + 0.5)
      }

      zonesLayer.clear()
      zoneLabels.removeChildren()
      for (const zone of worldConfig.zones || []) {
        const zoneColor = hexToNumber(zone.color, 0xd3c5a0)
        zonesLayer.beginFill(zoneColor, 0.14)
        zonesLayer.drawRoundedRect(zone.x, zone.y, zone.width, zone.height, 18)
        zonesLayer.endFill()

        zonesLayer.lineStyle(2, zoneColor, 0.5)
        zonesLayer.drawRoundedRect(zone.x, zone.y, zone.width, zone.height, 18)

        const label = new PIXI.Text({
          text: zone.name,
          style: {
            fill: 0x30465f,
            fontFamily: 'IBM Plex Mono',
            fontSize: 14,
            fontWeight: '700',
          },
        })
        label.position.set(zone.x + 12, zone.y + 10)
        zoneLabels.addChild(label)
      }
    }

    const setup = async () => {
      const app = new PIXI.Application()
      await app.init({
        resizeTo: hostRef.current,
        antialias: false,
        autoDensity: true,
        resolution: Math.max(window.devicePixelRatio || 1, 1),
        backgroundAlpha: 0,
      })

      if (cancelled) {
        app.destroy(true)
        return
      }

      hostRef.current.appendChild(app.canvas)

      const world = new PIXI.Container()
      const arena = new PIXI.Graphics()
      const zonesLayer = new PIXI.Graphics()
      const zoneLabels = new PIXI.Container()

      world.addChild(arena)
      world.addChild(zonesLayer)
      world.addChild(zoneLabels)
      app.stage.addChild(world)

      appRef.current = app
      worldRef.current = world
      arenaRef.current = arena
      zonesLayerRef.current = zonesLayer
      zoneLabelsRef.current = zoneLabels

      drawArena()
      app.renderer.on('resize', drawArena)
    }

    setup()

    return () => {
      cancelled = true
      avatarsRef.current.forEach((avatar) => avatar.container.destroy({ children: true }))
      avatarsRef.current.clear()

      if (appRef.current) {
        appRef.current.destroy(true)
      }

      appRef.current = null
      worldRef.current = null
      arenaRef.current = null
      zonesLayerRef.current = null
      zoneLabelsRef.current = null
    }
  }, [joined, worldConfig.worldHeight, worldConfig.worldWidth, worldConfig.zones])

  useEffect(() => {
    const world = worldRef.current
    if (!world) {
      return
    }

    const drawHat = (graphic, user) => {
      graphic.clear()
      const bodyColor = hexToNumber(user.avatarColor, 0x34d399)

      if (user.hat === 'cap') {
        graphic.beginFill(0x284760, 1)
        graphic.drawRoundedRect(-14, -23, 28, 8, 3)
        graphic.endFill()
        graphic.beginFill(bodyColor, 0.9)
        graphic.drawCircle(10, -19, 3)
        graphic.endFill()
      }

      if (user.hat === 'halo') {
        graphic.lineStyle(3, 0xf6b84e, 1)
        graphic.drawEllipse(0, -22, 13, 4)
      }

      if (user.hat === 'wizard') {
        graphic.beginFill(0x50366f, 1)
        graphic.moveTo(-12, -14)
        graphic.lineTo(0, -34)
        graphic.lineTo(12, -14)
        graphic.closePath()
        graphic.endFill()
      }
    }

    const avatars = avatarsRef.current
    const activeIds = new Set(Object.keys(users))

    for (const [id, avatar] of avatars.entries()) {
      if (!activeIds.has(id)) {
        world.removeChild(avatar.container)
        avatar.container.destroy({ children: true })
        avatars.delete(id)
      }
    }

    for (const user of Object.values(users)) {
      let avatar = avatars.get(user.id)
      if (!avatar) {
        const container = new PIXI.Container()
        const ring = new PIXI.Graphics()
        const body = new PIXI.Graphics()
        const hatGraphic = new PIXI.Graphics()
        const badgeLabel = new PIXI.Text({
          text: '',
          style: {
            fill: 0x2b3848,
            fontFamily: 'IBM Plex Mono',
            fontSize: 10,
            fontWeight: '700',
          },
        })

        badgeLabel.anchor.set(0.5, 0)
        badgeLabel.y = 15

        const nameLabel = new PIXI.Text({
          text: user.name,
          style: {
            fill: 0x173047,
            fontFamily: 'Manrope',
            fontSize: 14,
            fontWeight: '700',
          },
        })
        nameLabel.anchor.set(0.5, 1)
        nameLabel.y = -20

        const emoteLabel = new PIXI.Text({
          text: '',
          style: {
            fill: 0x1d2f44,
            fontFamily: 'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, Manrope',
            fontSize: 27,
            fontWeight: '700',
          },
        })
        emoteLabel.anchor.set(0.5, 1)
        emoteLabel.y = -44

        container.addChild(ring)
        container.addChild(body)
        container.addChild(hatGraphic)
        container.addChild(nameLabel)
        container.addChild(badgeLabel)
        container.addChild(emoteLabel)
        world.addChild(container)

        avatar = { container, ring, body, hatGraphic, nameLabel, badgeLabel, emoteLabel }
        avatars.set(user.id, avatar)
      }

      const isSelf = user.id === selfId
      const connected = connectedUserIds.includes(user.id)
      const baseColor = hexToNumber(user.avatarColor, isSelf ? 0x34d399 : 0x67a1cb)

      avatar.ring.clear()
      avatar.ring.lineStyle(2, 0x2f4963, isSelf || connected ? 0.26 : 0.1)
      avatar.ring.drawCircle(0, 0, worldConfig.proximityRadius)
      avatar.ring.visible = isSelf || connected

      avatar.body.clear()
      avatar.body.beginFill(baseColor, 1)
      avatar.body.drawCircle(0, 0, isSelf ? 15 : 12)
      avatar.body.endFill()

      drawHat(avatar.hatGraphic, user)

      avatar.nameLabel.text = user.name
      avatar.badgeLabel.text = user.badge && user.badge !== 'none' ? user.badge.toUpperCase() : ''
      avatar.emoteLabel.text = activeEmotes[user.id] ? EMOTE_LABELS[activeEmotes[user.id]] : ''

      avatar.container.position.set(user.x, user.y)
    }
  }, [activeEmotes, connectedUserIds, selfId, users, worldConfig.proximityRadius])

  const submitMessage = (event) => {
    event.preventDefault()
    if (!activeChatId || !draftMessage.trim() || !connectedUserIds.includes(activeChatId) || selectedUserBlocked) {
      return
    }

    socketRef.current?.emit('chat:send', {
      toUserId: activeChatId,
      text: draftMessage.trim(),
    })
    setDraftMessage('')
  }

  const submitProfileUpdate = () => {
    socketRef.current?.emit('user:profile:update', {
      name: displayName,
      avatarColor,
      hat,
      badge,
    })
  }

  const sendEmote = (emote) => {
    if (!activeChatId || !connectedUserIds.includes(activeChatId)) {
      return
    }

    socketRef.current?.emit('emote:send', {
      toUserId: activeChatId,
      emote,
    })
  }

  const toggleMute = () => {
    if (!selectedUser) {
      return
    }

    socketRef.current?.emit('moderation:mute', {
      targetUserId: selectedUser.id,
      muted: !selectedUserMuted,
    })
  }

  const toggleBlock = () => {
    if (!selectedUser) {
      return
    }

    socketRef.current?.emit('moderation:block', {
      targetUserId: selectedUser.id,
      blocked: !selectedUserBlocked,
    })
  }

  const submitReport = () => {
    if (!selectedUser) {
      return
    }

    socketRef.current?.emit('moderation:report', {
      targetUserId: selectedUser.id,
      reason: reportReason,
      details: reportDetails,
    })
  }

  const toggleVoice = async () => {
    if (!activeChatId || !connectedUserIds.includes(activeChatId)) {
      return
    }

    if (activeVoicePeerId === activeChatId && activeCallMode === 'voice') {
      closeVoicePeer(activeChatId, true)
      setVoiceError('')
      return
    }

    if (activeVoicePeerId) {
      closeVoicePeer(activeVoicePeerId, true)
    }

    await startVoiceCall(activeChatId)
  }

  const toggleVideo = async () => {
    if (!activeChatId || !connectedUserIds.includes(activeChatId)) {
      return
    }

    if (activeVoicePeerId === activeChatId && activeCallMode === 'video') {
      closeVoicePeer(activeChatId, true)
      setVoiceError('')
      return
    }

    if (activeVoicePeerId) {
      closeVoicePeer(activeVoicePeerId, true)
    }

    await startVideoCall(activeChatId)
  }

  const handleEnterCosmos = () => {
    setRoomId(safeRoomId(roomId))
    setJoined(true)
  }

  const handleSwitchRoom = () => {
    closeAllVoice()
    socketRef.current?.disconnect()
    setJoined(false)
    setSocketOnline(false)
    setConnectionLabel('Waiting')
    setSelfId('')
    setCurrentZoneId(null)
    setUsersSafe({})
    setConnectedUserIds([])
    setActiveChatId('')
    setMessagesByUser({})
    setVoiceError('')
  }

  return (
    <main className="app-shell">
      {!joined && (
        <section className="join-overlay">
          <div className="join-card fade-up">
            <p className="eyebrow mono">Virtual Cosmos</p>
            <h1 className="title-main">Step Into The Commons</h1>
            <p className="subtitle-text">
              Realtime movement, proximity chat, voice, and social controls in one shared map.
            </p>

            <label className="field-label" htmlFor="displayName">Display Name</label>
            <input
              id="displayName"
              value={displayName}
              maxLength={24}
              onChange={(event) => setDisplayName(event.target.value)}
              className="input-base"
              placeholder="Enter your alias"
            />

            <label className="field-label" htmlFor="roomId">Room ID</label>
            <input
              id="roomId"
              value={roomId}
              maxLength={32}
              onChange={(event) => setRoomId(event.target.value)}
              className="input-base"
              placeholder="e.g. team-alpha"
            />

            <div className="form-row">
              <div>
                <label className="field-label" htmlFor="avatarColor">Avatar Color</label>
                <input
                  id="avatarColor"
                  type="color"
                  value={avatarColor}
                  onChange={(event) => setAvatarColor(event.target.value)}
                  className="input-color"
                />
              </div>

              <div>
                <label className="field-label" htmlFor="hat">Hat</label>
                <select id="hat" value={hat} onChange={(event) => setHat(event.target.value)} className="input-base compact">
                  {HATS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="field-label" htmlFor="badge">Badge</label>
                <select id="badge" value={badge} onChange={(event) => setBadge(event.target.value)} className="input-base compact">
                  {BADGES.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
            </div>

            <button type="button" onClick={handleEnterCosmos} className="btn-primary">Enter Cosmos</button>
          </div>
        </section>
      )}

      <header className="surface header-surface fade-up">
        <div>
          <p className="eyebrow mono">Proximity-Driven World</p>
          <h2 className="title-main compact">Human-Crafted Collaboration Space</h2>
          <p className="subtitle-text">
            Walk in, connect in range, and carry conversations with zone-aware interactions.
          </p>
          <p className="subtitle-text mono">Room: {safeRoomId(roomId)}</p>
        </div>

        <div className="header-stats">
          <div className={`status-pill mono ${socketOnline ? 'online' : 'offline'}`}>
            <span className="status-dot"></span>
            {connectionLabel}
          </div>
          <div className="stats-row">
            <div className="small-card mono">Users<strong>{Object.keys(users).length}</strong></div>
            <div className="small-card mono">Nearby<strong>{connectedUsers.length}</strong></div>
          </div>
          <button className="btn-secondary" type="button" onClick={handleSwitchRoom}>Switch Room</button>
        </div>
      </header>

      <section className="layout-grid">
        <section className="surface world-card fade-up delay-1">
          <div className="world-toolbar">
            <p className="mono">Movement: WASD / Arrow Keys</p>
            <p className="mono">Proximity Radius: {worldConfig.proximityRadius}px</p>
          </div>

          <div ref={hostRef} className="cosmos-canvas"></div>

          <div className="world-meta">
            <span className="meta-pill">Pilot <strong>{selfUser?.name || displayName}</strong></span>
            <span className="meta-pill mono">Room ID: {safeRoomId(roomId)}</span>
            <span className="meta-pill mono">Current Zone: {currentZone?.name || 'Open Space'}</span>
            <span className="meta-pill mono">Active Call: {activeVoicePeerId ? `${activeCallMode.toUpperCase()} with ${users[activeVoicePeerId]?.name || 'Peer'}` : 'None'}</span>
          </div>

          {zoneNotice && <p className="zone-notice mono">{zoneNotice}</p>}

          <div className="zones-grid">
            {(worldConfig.zones || []).map((zone) => (
              <div key={zone.id} className={`zone-chip ${currentZoneId === zone.id ? 'active' : ''}`}>
                <span>{zone.name}</span>
                <strong className="mono">{zoneCounts[zone.id] || 0}</strong>
              </div>
            ))}
          </div>

          <div className="video-strip">
            <div className="video-box">
              <p className="mono video-title">You</p>
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={`video-preview ${activeCallMode === 'video' ? '' : 'hidden'}`}
              ></video>
              {activeCallMode !== 'video' && <p className="inline-note">Camera off</p>}
            </div>
            <div className="video-box">
              <p className="mono video-title">Peer</p>
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                muted
                className={`video-preview ${remoteVideoStream ? '' : 'hidden'}`}
              ></video>
              {!remoteVideoStream && <p className="inline-note">No remote video</p>}
            </div>
          </div>
        </section>

        <aside className="surface chat-card fade-up delay-2">
          <p className="eyebrow mono">Nearby Connections</p>

          {connectedUsers.length > 0 ? (
            <div className="chip-list">
              {connectedUsers.map((user) => (
                <button
                  key={user.id}
                  onClick={() => setActiveChatId(user.id)}
                  className={`chip ${activeChatId === user.id ? 'active' : ''}`}
                >
                  {user.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-note">Move closer to another avatar to unlock text, voice, and video channels.</p>
          )}

          <div className="message-list">
            {chatMessages.length > 0 ? (
              chatMessages
                .filter((message) => {
                  const isIncoming = message.fromId !== selfId
                  if (!isIncoming) {
                    return true
                  }

                  const sender = users[message.fromId]
                  return !sender || !mutedUserKeys.includes(sender.userId)
                })
                .map((message, index) => {
                  const outgoing = message.fromId === selfId
                  return (
                    <div key={`${message.sentAt}-${index}`} className={`bubble ${outgoing ? 'outgoing' : 'incoming'}`}>
                      <p>{message.text}</p>
                      <p className="mono bubble-time">{new Date(message.sentAt).toLocaleTimeString()}</p>
                    </div>
                  )
                })
            ) : (
              <p className="empty-chat">{activeChatId ? 'Say hello while you are in range.' : 'No active conversation yet.'}</p>
            )}
          </div>

          <form onSubmit={submitMessage} className="input-row">
            <input
              value={draftMessage}
              maxLength={300}
              disabled={!activeChatId || selectedUserBlocked}
              onChange={(event) => setDraftMessage(event.target.value)}
              className="input-base compact"
              placeholder={
                !activeChatId
                  ? 'Chat unavailable until proximity connect'
                  : selectedUserBlocked
                    ? 'Unblock this user to send messages'
                    : 'Type your message...'
              }
            />
            <button type="submit" disabled={!activeChatId || !draftMessage.trim() || selectedUserBlocked} className="btn-send">Send</button>
          </form>

          <div className="panel-row">
            <button className="btn-secondary" type="button" disabled={!activeChatId} onClick={toggleVoice}>
              {activeVoicePeerId === activeChatId && activeCallMode === 'voice' ? 'End Voice' : 'Start Voice'}
            </button>
            <button className="btn-secondary" type="button" disabled={!activeChatId} onClick={toggleVideo}>
              {activeVoicePeerId === activeChatId && activeCallMode === 'video' ? 'End Video' : 'Start Video'}
            </button>
            {voiceError && <span className="inline-note">{voiceError}</span>}
          </div>

          <div className="emote-row">
            {EMOTE_OPTIONS.map((emote) => (
              <button
                key={emote}
                type="button"
                disabled={!activeChatId || !connectedUserIds.includes(activeChatId)}
                className="btn-emote"
                onClick={() => sendEmote(emote)}
              >
                {EMOTE_BUTTON_LABELS[emote]}
              </button>
            ))}
          </div>

          <div className="moderation-box">
            <p className="eyebrow mono">Moderation</p>
            <div className="panel-row">
              <button className="btn-secondary" type="button" disabled={!selectedUser} onClick={toggleMute}>
                {selectedUserMuted ? 'Unmute User' : 'Mute User'}
              </button>
              <button className="btn-danger" type="button" disabled={!selectedUser} onClick={toggleBlock}>
                {selectedUserBlocked ? 'Unblock User' : 'Block User'}
              </button>
            </div>

            <div className="report-row">
              <select className="input-base compact" value={reportReason} onChange={(event) => setReportReason(event.target.value)}>
                <option value="spam">spam</option>
                <option value="abuse">abuse</option>
                <option value="harassment">harassment</option>
                <option value="other">other</option>
              </select>
              <input
                className="input-base compact"
                value={reportDetails}
                onChange={(event) => setReportDetails(event.target.value)}
                placeholder="Optional report details"
                maxLength={200}
              />
              <button type="button" className="btn-send" disabled={!selectedUser} onClick={submitReport}>Report</button>
            </div>
            {reportAck && <p className="inline-note">{reportAck}</p>}
          </div>

          <div className="profile-box">
            <p className="eyebrow mono">Profile Customization</p>
            <div className="form-row">
              <input type="color" value={avatarColor} className="input-color" onChange={(event) => setAvatarColor(event.target.value)} />
              <select className="input-base compact" value={hat} onChange={(event) => setHat(event.target.value)}>
                {HATS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              <select className="input-base compact" value={badge} onChange={(event) => setBadge(event.target.value)}>
                {BADGES.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
            <button type="button" className="btn-secondary" onClick={submitProfileUpdate}>Apply Profile</button>
          </div>
        </aside>
      </section>
    </main>
  )
}

export default App
