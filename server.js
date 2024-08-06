const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const math = require('mathjs');
const winston = require('winston');
require('winston-mongodb');
const http = require('http');
const socketIo = require('socket.io');

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.File({
      filename: 'logs/server.log',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'MMM-DD-YYYY HH:mm:ss' }),
        winston.format.align(),
        winston.format.printf((info) => `${info.level}: ${info.timestamp}: ${info.message}`)
      ),
    }),
    new winston.transports.MongoDB({
      level: 'error',
      db: 'mongodb+srv://sourabhpatil0369:E03jEzYLpOiI30z2@cluster0.uscvgdc.mongodb.net/',
      options: {
        useUnifiedTopology: true,
      },
      collection: 'server_logs',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    }),
  ],
});

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://sourabhpatil0369:E03jEzYLpOiI30z2@cluster0.uscvgdc.mongodb.net/';

const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');
  } catch (err) {
    logger.error(`Error connecting to MongoDB: ${err.message}`);
    console.error('Error connecting to MongoDB:', err.message);
    process.exit(1); // Exit the process with failure
  }
};

// Calculator Log Schema
const calculatorLogSchema = new mongoose.Schema({
  expression: { type: String, required: true },
  isValid: { type: Boolean, required: true },
  output: { type: Number, required: true },
  createdOn: { type: Date, default: Date.now },
});

const CalculatorLog = mongoose.model('CalculatorLog', calculatorLogSchema);

// Express App Setup
const app = express();
app.use(cors());
app.use(express.json());

// HTTP server and WebSocket setup
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

// Handle WebSocket connections
io.on('connection', (socket) => {
  console.log('New WebSocket connection');

  socket.on('log', async (data) => {
    try {
      // Check if the expression is already logged in the last few seconds
      const recentLogs = await CalculatorLog.find({ expression: data.expression })
        .sort({ createdOn: -1 })
        .limit(1)
        .exec();

      if (!recentLogs.length || (new Date() - recentLogs[0].createdOn) > 5000) { // 5 seconds gap
        const calculatorLog = new CalculatorLog(data);
        await calculatorLog.save();
        logger.info(`Expression logged via WebSocket: ${data.expression} | Valid: ${data.isValid}`);

        // Emit the new log to all connected clients
        io.emit('new-log', data);
      }
    } catch (err) {
      logger.error(`Error logging expression via WebSocket: ${err.message}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('WebSocket disconnected');
  });
});

// Helper function to handle database operations
const handleDbOperation = (operation) => async (req, res, next) => {
  try {
    await operation(req, res);
  } catch (error) {
    logger.error(`Database operation error: ${error.message}`);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

// POST /api/logs - Log a new calculator expression
app.post('/api/logs', handleDbOperation(async (req, res) => {
  const { expression } = req.body;
  if (!expression) {
    logger.info('Received an empty expression');
    return res.status(400).json({ message: 'Expression is empty' });
  }
  let output = null;
  let isValid = true;
  try {
    output = math.evaluate(expression);
    output = parseFloat(output.toFixed(2)); // Format to 2 decimal places
    isValid = true;
  } catch (err) {
    logger.warn(`Invalid expression attempted: ${expression}`);
    isValid = false;
  }

  const calculatorLog = new CalculatorLog({ expression, isValid, output });
  await calculatorLog.save();
  logger.info(`Expression logged: ${expression} | Valid: ${isValid}`);

  // Emit the new log to all connected WebSocket clients
  io.emit('new-log', { expression, isValid, output, createdOn: new Date().toISOString() });

  return res.json({
    message: isValid ? `Expression evaluated to ${output}` : 'Invalid expression',
    output: isValid ? output : null,
    isValid,
  });
}));

// GET /api/logs - Latest 10 calculator logs
app.get('/api/logs', handleDbOperation(async (req, res) => {
  const sinceId = req.query.since_id;
  let query = {};
  if (sinceId) {
    query = { _id: { $gt: sinceId } };
  }
  const logs = await CalculatorLog.find(query).sort({ createdOn: -1 }).limit(10).exec();
  logger.info('Successfully retrieved logs');
  res.json(logs);
}));

app.get('/', (req, res) => {
  res.send('Hello from the Calculator Log API!');
  logger.info('Served root endpoint');
});

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  logger.info(`Server started on port ${PORT}`);
});

// Connect to the database
connectDB();

// Handle Uncaught Exceptions and Promise Rejections
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
