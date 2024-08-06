// websockets.js
const logger = require('./config/logger');
const CalculatorLog = require('./models/CalculatorLog');

const setupWebSockets = (io) => {
  io.on('connection', (socket) => {
    console.log('New WebSocket connection');

    socket.on('log', async (data) => {
      try {
        const calculatorLog = new CalculatorLog(data);
        await calculatorLog.save();
        logger.info(`Expression logged via WebSocket: ${data.expression} | Valid: ${data.isValid}`);

        // Emit the new log to all connected clients
        io.emit('new-log', data);
      } catch (err) {
        logger.error(`Error logging expression via WebSocket: ${err.message}`);
      }
    });

    socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
    });
  });
};

module.exports = { setupWebSockets };
