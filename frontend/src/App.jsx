import { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import * as PIXI from 'pixi.js'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000'
const SPEED = 280

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

const toUserMap = (users) => Object.fromEntries(users.map((user) => [user.id, user]))

function App() {
  const [joined, setJoined] = useState(false)
  const [displayName, setDisplayName] = useState(`Cosmo-${Math.floor(Math.random() * 900 + 100)}`)
  const [socketOnline, setSocketOnline] = useState(false)
  const [selfId, setSelfId] = useState('')
  const [worldConfig, setWorldConfig] = useState({
    worldWidth: 1600,
    worldHeight: 900,
    proximityRadius: 190,
  })
  const [users, setUsers] = useState({})
  const [connectedUserIds, setConnectedUserIds] = useState([])
  const [activeChatId, setActiveChatId] = useState('')
  const [messagesByUser, setMessagesByUser] = useState({})
  const [draftMessage, setDraftMessage] = useState('')

  const socketRef = useRef(null)
  const keyStateRef = useRef(new Set())
  const hostRef = useRef(null)
  const appRef = useRef(null)
  const worldRef = useRef(null)
  const arenaRef = useRef(null)
  const avatarsRef = useRef(new Map())
  const selfIdRef = useRef('')
  const latestSelfPosRef = useRef({ x: 0, y: 0 })

  const selfUser = users[selfId]
  const connectedUsers = useMemo(
    () => connectedUserIds.map((userId) => users[userId]).filter(Boolean),
    [connectedUserIds, users],
  )
  const chatMessages = activeChatId ? messagesByUser[activeChatId] || [] : []

  useEffect(() => {
    selfIdRef.current = selfId
  }, [selfId])

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
    if (!joined) {
      return
    }

    const storedUserKey = sessionStorage.getItem('cosmos-user-key') || crypto.randomUUID()
    sessionStorage.setItem('cosmos-user-key', storedUserKey)

    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      auth: {
        name: displayName.trim() || 'Cosmonaut',
        userKey: storedUserKey,
      },
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setSocketOnline(true)
    })

    socket.on('disconnect', () => {
      setSocketOnline(false)
      setConnectedUserIds([])
    })

    socket.on('world:init', (payload) => {
      setSelfId(payload.selfId)
      setWorldConfig(payload.config)
      setUsers(toUserMap(payload.users))
      const current = payload.users.find((user) => user.id === payload.selfId)
      if (current) {
        latestSelfPosRef.current = { x: current.x, y: current.y }
      }
    })

    socket.on('world:user-joined', (user) => {
      setUsers((prev) => ({ ...prev, [user.id]: user }))
    })

    socket.on('world:user-moved', (user) => {
      if (user.id === selfIdRef.current) {
        latestSelfPosRef.current = { x: user.x, y: user.y }
      }

      setUsers((prev) => ({
        ...prev,
        [user.id]: {
          ...(prev[user.id] || {}),
          ...user,
        },
      }))
    })

    socket.on('world:user-left', ({ id }) => {
      setUsers((prev) => {
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

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [displayName, joined])

  useEffect(() => {
    if (!joined) {
      return
    }

    const onKeyDown = (event) => {
      const key = event.key.toLowerCase()
      if (!MOVEMENT_KEYS[key]) {
        return
      }

      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          return
        }
      }

      event.preventDefault()
      keyStateRef.current.add(key)
    }

    const onKeyUp = (event) => {
      keyStateRef.current.delete(event.key.toLowerCase())
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      keyStateRef.current.clear()
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
      const delta = (now - previousTime) / 1000
      previousTime = now

      const self = users[selfId]
      if (self) {
        let axisX = 0
        let axisY = 0

        for (const key of keyStateRef.current) {
          axisX += MOVEMENT_KEYS[key][0]
          axisY += MOVEMENT_KEYS[key][1]
        }

        if (axisX !== 0 || axisY !== 0) {
          const magnitude = Math.sqrt(axisX * axisX + axisY * axisY) || 1
          const normalizedX = axisX / magnitude
          const normalizedY = axisY / magnitude

          const nextX = clamp(self.x + normalizedX * SPEED * delta, 0, worldConfig.worldWidth)
          const nextY = clamp(self.y + normalizedY * SPEED * delta, 0, worldConfig.worldHeight)

          latestSelfPosRef.current = { x: nextX, y: nextY }

          setUsers((prev) => ({
            ...prev,
            [selfId]: {
              ...prev[selfId],
              x: nextX,
              y: nextY,
            },
          }))

          if (now - lastSentAt > 40) {
            socketRef.current?.emit('player:move', { x: nextX, y: nextY })
            lastSentAt = now
          }
        }
      }

      animationFrameId = requestAnimationFrame(step)
    }

    animationFrameId = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(animationFrameId)
    }
  }, [joined, selfId, users, worldConfig.worldHeight, worldConfig.worldWidth])

  useEffect(() => {
    if (!joined || !hostRef.current) {
      return
    }

    let cancelled = false

    const drawArena = () => {
      const app = appRef.current
      const world = worldRef.current
      const arena = arenaRef.current
      if (!app || !world || !arena) {
        return
      }

      const screenW = app.renderer.width
      const screenH = app.renderer.height
      const padding = 18
      const ratio = Math.min(
        (screenW - padding * 2) / worldConfig.worldWidth,
        (screenH - padding * 2) / worldConfig.worldHeight,
      )

      world.scale.set(ratio)
      world.position.set(
        (screenW - worldConfig.worldWidth * ratio) / 2,
        (screenH - worldConfig.worldHeight * ratio) / 2,
      )

      arena.clear()
      arena.beginFill(0x072734, 1)
      arena.drawRoundedRect(0, 0, worldConfig.worldWidth, worldConfig.worldHeight, 26)
      arena.endFill()

      arena.lineStyle(3, 0x82f6d8, 0.55)
      arena.drawRoundedRect(0, 0, worldConfig.worldWidth, worldConfig.worldHeight, 26)

      arena.lineStyle(1, 0x1e4958, 0.52)
      for (let x = 80; x < worldConfig.worldWidth; x += 80) {
        arena.moveTo(x, 0)
        arena.lineTo(x, worldConfig.worldHeight)
      }

      for (let y = 80; y < worldConfig.worldHeight; y += 80) {
        arena.moveTo(0, y)
        arena.lineTo(worldConfig.worldWidth, y)
      }
    }

    const setup = async () => {
      const app = new PIXI.Application()
      await app.init({
        resizeTo: hostRef.current,
        antialias: true,
        backgroundAlpha: 0,
      })

      if (cancelled) {
        app.destroy(true)
        return
      }

      hostRef.current.appendChild(app.canvas)

      const world = new PIXI.Container()
      const arena = new PIXI.Graphics()
      world.addChild(arena)
      app.stage.addChild(world)

      appRef.current = app
      worldRef.current = world
      arenaRef.current = arena

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
    }
  }, [joined, worldConfig.worldHeight, worldConfig.worldWidth])

  useEffect(() => {
    const world = worldRef.current
    if (!world) {
      return
    }

    const avatars = avatarsRef.current
    const activeUserIds = new Set(Object.keys(users))

    for (const [userId, avatar] of avatars.entries()) {
      if (!activeUserIds.has(userId)) {
        world.removeChild(avatar.container)
        avatar.container.destroy({ children: true })
        avatars.delete(userId)
      }
    }

    for (const user of Object.values(users)) {
      let avatar = avatars.get(user.id)
      if (!avatar) {
        const container = new PIXI.Container()
        const ring = new PIXI.Graphics()
        const body = new PIXI.Graphics()
        const label = new PIXI.Text({
          text: user.name,
          style: {
            fill: 0xd6fff3,
            fontFamily: 'Space Grotesk',
            fontSize: 16,
            fontWeight: '600',
          },
        })

        label.anchor.set(0.5, 1)
        label.y = -20

        container.addChild(ring)
        container.addChild(body)
        container.addChild(label)
        world.addChild(container)

        avatar = { container, ring, body, label }
        avatars.set(user.id, avatar)
      }

      const isSelf = user.id === selfId
      const isConnected = connectedUserIds.includes(user.id)
      const color = isSelf ? 0x34d399 : isConnected ? 0xfbbf24 : 0x7dd3fc

      avatar.ring.clear()
      avatar.ring.lineStyle(2, color, isSelf ? 0.3 : 0.17)
      avatar.ring.drawCircle(0, 0, worldConfig.proximityRadius)
      avatar.ring.visible = isSelf || isConnected

      avatar.body.clear()
      avatar.body.beginFill(color, 1)
      avatar.body.drawCircle(0, 0, isSelf ? 15 : 12)
      avatar.body.endFill()

      avatar.label.text = user.name
      avatar.container.position.set(user.x, user.y)
    }
  }, [connectedUserIds, selfId, users, worldConfig.proximityRadius])

  const submitMessage = (event) => {
    event.preventDefault()

    if (!activeChatId || !draftMessage.trim() || !connectedUserIds.includes(activeChatId)) {
      return
    }

    socketRef.current?.emit('chat:send', {
      toUserId: activeChatId,
      text: draftMessage.trim(),
    })

    setDraftMessage('')
  }

  return (
    <main className="app-shell">
      {!joined && (
        <section className="join-overlay">
          <div className="join-card fade-up">
            <p className="eyebrow mono">Virtual Cosmos</p>
            <h1 className="title-main">Step Into The Commons</h1>
            <p className="subtitle-text">
              Move with WASD or Arrow keys. Chat turns on only when you are close to other users.
            </p>

            <label className="field-label" htmlFor="displayName">
              Display Name
            </label>
            <input
              id="displayName"
              value={displayName}
              maxLength={24}
              onChange={(event) => setDisplayName(event.target.value)}
              className="input-base"
              placeholder="Enter your alias"
            />

            <button
              type="button"
              onClick={() => setJoined(true)}
              className="btn-primary"
            >
              Enter Cosmos
            </button>
          </div>
        </section>
      )}

      <header className="surface header-surface fade-up">
        <div>
          <p className="eyebrow mono">Proximity-Driven World</p>
          <h2 className="title-main compact">Neighborhood Voice Space</h2>
          <p className="subtitle-text">
            Walk near people to auto-open a private channel. Walk away and the channel closes.
          </p>
        </div>

        <div className="header-stats">
          <div className={`status-pill mono ${socketOnline ? 'online' : 'offline'}`}>
            <span className="status-dot"></span>
            {socketOnline ? 'Socket Online' : 'Socket Offline'}
          </div>

          <div className="stats-row">
            <div className="small-card mono">
              Users
              <strong>{Object.keys(users).length}</strong>
            </div>
            <div className="small-card mono">
              Nearby
              <strong>{connectedUsers.length}</strong>
            </div>
          </div>
        </div>
      </header>

      <section className="layout-grid">
        <div className="surface world-card fade-up delay-1">
          <div className="world-toolbar">
            <p className="mono">Movement: WASD / Arrow Keys</p>
            <p className="mono">Radius chat: {worldConfig.proximityRadius}px</p>
          </div>

          <div ref={hostRef} className="cosmos-canvas"></div>

          <div className="world-meta">
            <span className="meta-pill">
              Pilot <strong>{selfUser?.name || displayName}</strong>
            </span>
            <span className="meta-pill mono">In Space {Object.keys(users).length}</span>
            <span className="meta-pill mono">Connected {connectedUsers.length}</span>
          </div>
        </div>

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
            <p className="empty-note">
              Move closer to another avatar to auto-connect and unlock chat.
            </p>
          )}

          <div className="message-list">
            {chatMessages.length > 0 ? (
              chatMessages.map((message, index) => {
                const outgoing = message.fromId === selfId

                return (
                  <div
                    key={`${message.sentAt}-${index}`}
                    className={`bubble ${outgoing ? 'outgoing' : 'incoming'}`}
                  >
                    <p>{message.text}</p>
                    <p className="mono bubble-time">
                      {new Date(message.sentAt).toLocaleTimeString()}
                    </p>
                  </div>
                )
              })
            ) : (
              <p className="empty-chat">
                {activeChatId ? 'Say hello while you are in range.' : 'No active conversation yet.'}
              </p>
            )}
          </div>

          <form onSubmit={submitMessage} className="input-row">
            <input
              value={draftMessage}
              maxLength={300}
              disabled={!activeChatId}
              onChange={(event) => setDraftMessage(event.target.value)}
              className="input-base compact"
              placeholder={activeChatId ? 'Type your message...' : 'Chat unavailable until proximity connect'}
            />
            <button
              type="submit"
              disabled={!activeChatId || !draftMessage.trim()}
              className="btn-send"
            >
              Send
            </button>
          </form>
        </aside>
      </section>
    </main>
  )
}

export default App
