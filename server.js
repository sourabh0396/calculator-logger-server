const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const math = require('mathjs');
const winston = require('winston');
require('winston-mongodb');
const http = require('http');
const socketIo = require('socket.io');

// const router = express.Router();

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
  status: { type: String, default: 'pending' } // Add status field
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
    // origin: 'http://localhost:5173',
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
// const handleDbOperation = (operation) => async (req, res, next) => {
//   try {
//     await operation(req, res);
//   } catch (error) {
//     logger.error(`Database operation error: ${error.message}`);
//     next(error); // Pass the error to the next middleware
//   }
// };

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


// app.use('/api', router);

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

// app.get('/api/long-polling/logs', async (req, res) => {
//   const { since_id } = req.query;
//   let query = {};

//   if (since_id) {
//     query = { _id: { $gt: since_id } };
//   }

//   const logs = await CalculatorLog.find(query).sort({ createdOn: -1 }).limit(5).exec();

//   if (logs.length > 0) {
//     res.json(logs);
//   } else {
//     res.status(204).end();
//   }
// });

app.get('/api/long-polling/logs', async (req, res) => {
  const { since_id } = req.query;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let query = {};
  if (since_id) {
    query = { _id: { $gt: since_id } };
  }

  try {
    const logs = await CalculatorLog.find(query).sort({ createdOn: -1 }).limit(5).exec();

    if (logs.length === 0) {
      res.status(204).end(); // No logs found
      return;
    }

    let currentIndex = 0;

    const interval = setInterval(() => {
      if (currentIndex < logs.length) {
        const log = logs[currentIndex];
        res.write(JSON.stringify(log) + '\n');
        currentIndex++;
      } else {
        clearInterval(interval);
        res.end(); // End the response when all logs are sent
      }
    }, 3000);

    req.on('close', () => {
      clearInterval(interval);
      res.end();
    });

  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  logger.info(`Server started on port ${PORT}`);
});

// Connect to the database
connectDB();

// const express = require('express');
// const mongoose = require('mongoose');
// const cors = require('cors');
// const math = require('mathjs');
// const winston = require('winston');
// require('winston-mongodb');
// const http = require('http');
// const socketIo = require('socket.io');

// // Configure Winston logger
// const logger = winston.createLogger({
//   level: 'info',
//   transports: [
//     new winston.transports.File({
//       filename: 'logs/server.log',
//       format: winston.format.combine(
//         winston.format.timestamp({ format: 'MMM-DD-YYYY HH:mm:ss' }),
//         winston.format.align(),
//         winston.format.printf((info) => `${info.level}: ${info.timestamp}: ${info.message}`)
//       ),
//     }),
//     new winston.transports.MongoDB({
//       level: 'error',
//       db: 'mongodb+srv://sourabhpatil0369:E03jEzYLpOiI30z2@cluster0.uscvgdc.mongodb.net/',
//       options: {
//         useUnifiedTopology: true,
//       },
//       collection: 'server_logs',
//       format: winston.format.combine(
//         winston.format.timestamp(),
//         winston.format.json()
//       ),
//     }),
//   ],
// });

// // Database connection
// const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://sourabhpatil0369:E03jEzYLpOiI30z2@cluster0.uscvgdc.mongodb.net/';

// const connectDB = async () => {
//   try {
//     await mongoose.connect(MONGODB_URI, {
//       useNewUrlParser: true,
//       useUnifiedTopology: true,
//     });
//     console.log('Connected to MongoDB');
//   } catch (err) {
//     logger.error(`Error connecting to MongoDB: ${err.message}`);
//     console.error('Error connecting to MongoDB:', err.message);
//     process.exit(1); // Exit the process with failure
//   }
// };

// // Calculator Log Schema
// const calculatorLogSchema = new mongoose.Schema({
//   expression: { type: String, required: true },
//   isValid: { type: Boolean, required: true },
//   output: { type: Number, required: true },
//   createdOn: { type: Date, default: Date.now },
//   status: { type: String, default: 'pending' } // Add status field
// });

// const CalculatorLog = mongoose.model('CalculatorLog', calculatorLogSchema);

// // Express App Setup
// const app = express();
// app.use(cors());
// app.use(express.json());

// // HTTP server and WebSocket setup
// const server = http.createServer(app);
// const io = socketIo(server, {
//   cors: {
//     origin: 'http://localhost:5173',
//     methods: ['GET', 'POST'],
//   },
// });

// // Handle WebSocket connections
// io.on('connection', (socket) => {
//   console.log('New WebSocket connection');

//   socket.on('log', async (data) => {
//     try {
//       // Check if the expression is already logged in the last few seconds
//       const recentLogs = await CalculatorLog.find({ expression: data.expression })
//         .sort({ createdOn: -1 })
//         .limit(1)
//         .exec();

//       if (!recentLogs.length || (new Date() - recentLogs[0].createdOn) > 5000) { // 5 seconds gap
//         const calculatorLog = new CalculatorLog(data);
//         await calculatorLog.save();
//         logger.info(`Expression logged via WebSocket: ${data.expression} | Valid: ${data.isValid}`);

//         // Emit the new log to all connected clients
//         io.emit('new-log', data);
//       }
//     } catch (err) {
//       logger.error(`Error logging expression via WebSocket: ${err.message}`);
//     }
//   });

//   socket.on('disconnect', () => {
//     console.log('WebSocket disconnected');
//   });
// });

// // Helper function to handle database operations
// const handleDbOperation = (operation) => async (req, res, next) => {
//   try {
//     await operation(req, res);
//   } catch (error) {
//     logger.error(`Database operation error: ${error.message}`);
//     res.status(500).json({ message: 'Internal Server Error' });
//   }
// };

// // POST /api/logs - Log a new calculator expression
// app.post('/api/logs', handleDbOperation(async (req, res) => {
//   const { expression } = req.body;
//   if (!expression) {
//     logger.info('Received an empty expression');
//     return res.status(400).json({ message: 'Expression is empty' });
//   }
//   let output = null;
//   let isValid = true;
//   try {
//     output = math.evaluate(expression);
//     output = parseFloat(output.toFixed(2)); // Format to 2 decimal places
//     isValid = true;
//   } catch (err) {
//     logger.warn(`Invalid expression attempted: ${expression}`);
//     isValid = false;
//   }

//   const calculatorLog = new CalculatorLog({ expression, isValid, output });
//   await calculatorLog.save();
//   logger.info(`Expression logged: ${expression} | Valid: ${isValid}`);

//   // Emit the new log to all connected WebSocket clients
//   io.emit('new-log', { expression, isValid, output, createdOn: new Date().toISOString() });

//   return res.json({
//     message: isValid ? `Expression evaluated to ${output}` : 'Invalid expression',
//     output: isValid ? output : null,
//     isValid,
//   });
// }));

// // GET /api/logs - Latest 10 calculator logs
// app.get('/api/logs', handleDbOperation(async (req, res) => {
//   const sinceId = req.query.since_id;
//   let query = {};
//   if (sinceId) {
//     query = { _id: { $gt: sinceId } };
//   }
//   const logs = await CalculatorLog.find(query).sort({ createdOn: -1 }).limit(10).exec();
//   logger.info('Successfully retrieved logs');
//   res.json(logs);
// }));

// // GET /api/long-polling/logs - Long polling for logs
// app.get('/api/long-polling/logs', handleDbOperation(async (req, res) => {
//   const sinceId = req.query.since_id;
//   let query = {};
//   if (sinceId) {
//     query = { _id: { $gt: sinceId } };
//   }

//   // Function to send logs when available
//   const sendLogs = async () => {
//     const logs = await CalculatorLog.find(query).sort({ createdOn: -1 }).limit(10).exec();
//     if (logs.length > 0) {
//       logger.info('Successfully retrieved logs for long polling');
//       return res.json(logs);
//     }
//     return null;
//   };

//   // Check for new logs every 2 seconds
//   const interval = setInterval(async () => {
//     const logsAvailable = await sendLogs();
//     if (logsAvailable) {
//       clearInterval(interval);
//     }
//   }, 2000);

//   // Clear interval and respond when request times out after 30 seconds
//   setTimeout(() => {
//     clearInterval(interval);
//     res.status(204).end(); // No content
//   }, 30000);
// }));

// // GET /api/bulk-logs - Fetch and update all pending logs in bulk after five executions
// app.get('/api/bulk-logs', handleDbOperation(async (req, res) => {
//   // Fetch pending logs and update them as completed
//   const logs = await CalculatorLog.find({ status: 'pending' }).limit(5).exec();
//   if (logs.length === 5) {
//     // Update status of logs to 'completed'
//     await CalculatorLog.updateMany({ _id: { $in: logs.map(log => log._id) } }, { status: 'completed' });
//     res.json(logs);
//   } else {
//     res.status(204).end(); // No content
//   }
// }));

// // Start the server
// const PORT = process.env.PORT || 5000;
// server.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
//   logger.info(`Server started on port ${PORT}`);
// });

// // Connect to the database
// connectDB();
