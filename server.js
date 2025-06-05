import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const app = express();

// Basic middleware
app.use(helmet());
app.use(cors({
  origin: [
    /\.myshopify\.com$/,
    process.env.SHOPIFY_STORE_URL || 'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Peptide Radar API Server Running (Basic Version)', 
    timestamp: new Date().toISOString(),
    message: 'Ready to add Twilio credentials!'
  });
});

// Basic API endpoint for testing
app.get('/api/test', (req, res) => {
  res.json({ message: 'API is working!' });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Peptide Radar server running on port ${PORT}`);
});
