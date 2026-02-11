const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

let io = null;

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: '*' },
    pingTimeout: 60000,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Auth required'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('role');
      if (!user) return next(new Error('User not found'));
      socket.userId = decoded.id;
      socket.isAdmin = user.role === 'admin';
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    socket.join(`user:${userId}`);
    if (socket.isAdmin) socket.join('admin');
    socket.emit('connected', { userId });
  });

  return io;
};

const getIO = () => io;

const emitNotification = (notification) => {
  if (!io) return;
  const n = notification.toObject ? notification.toObject() : notification;
  if (n.forAdmin) {
    io.to('admin').emit('notification', n);
  } else if (n.userId) {
    const uid = n.userId._id || n.userId;
    io.to(`user:${uid}`).emit('notification', n);
  }
};

module.exports = { initSocket, getIO, emitNotification };
