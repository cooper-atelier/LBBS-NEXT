import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import config from '../config.js'

let io = null

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.allowedOrigins }
  })

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('AUTH_REQUIRED'))
    try {
      const payload = jwt.verify(token, config.jwtSecret)
      socket.userId = payload.sub
      socket.userRole = payload.role
      next()
    } catch {
      next(new Error('INVALID_TOKEN'))
    }
  })

  io.on('connection', (socket) => {
    socket.on('join_board', ({ board_id }) => {
      socket.join(`board:${board_id}`)
    })
  })

  return io
}

export function getIo() { return io }
