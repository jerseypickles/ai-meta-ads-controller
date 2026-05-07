const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../utils/logger');

let isConnected = false;

async function connect() {
  if (isConnected) return;

  try {
    mongoose.set('strictQuery', false);

    await mongoose.connect(config.mongodb.uri, {
      maxPoolSize: 10,
      minPoolSize: 2,                  // mantén 2 conexiones vivas para evitar cold-start
      maxIdleTimeMS: 60000,            // cierra conexiones idle >60s — previene zombies
      serverSelectionTimeoutMS: 10000, // 10s para seleccionar servidor (era 5s, muy corto)
      socketTimeoutMS: 30000,          // 30s socket timeout (era 45s — zombies vivían demasiado)
      retryReads: true,                // reintenta reads automáticamente en transient failures
      heartbeatFrequencyMS: 10000      // chequea salud cada 10s
    });

    isConnected = true;
    logger.info('MongoDB conectado exitosamente');

    mongoose.connection.on('error', (err) => {
      logger.error('Error de conexión MongoDB:', err);
      isConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB desconectado');
      isConnected = false;
    });
  } catch (error) {
    logger.error('Fallo al conectar MongoDB:', error);
    throw error;
  }
}

async function disconnect() {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  logger.info('MongoDB desconectado correctamente');
}

function getStatus() {
  return {
    connected: isConnected,
    state: mongoose.connection.readyState
  };
}

module.exports = { connect, disconnect, getStatus };
