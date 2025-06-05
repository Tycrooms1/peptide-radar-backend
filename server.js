// server.js - Complete Enhanced Backend with Mailchimp Integration
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createHmac } from 'crypto';
import twilio from 'twilio';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import mailchimp from '@mailchimp/mailchimp_marketing';

const app = express();
const prisma = new PrismaClient();

// Initialize Twilio (with error handling)
let twilioClient = null;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch (error) {
  console.warn('Twilio not configured:', error.message);
}

// Configure Mailchimp (with error handling)
if (process.env.MAILCHIMP_API_KEY && process.env.MAILCHIMP_SERVER_PREFIX) {
  mailchimp.setConfig({
    apiKey: process.env.MAILCHIMP_API_KEY,
    server: process.env.MAILCHIMP_SERVER_PREFIX
  });
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: [
    /\.myshopify\.com$/,
    process.env.SHOPIFY_STORE_URL,
    'http://localhost:3000'
  ],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// Body parser for webhooks (raw for Shopify verification)
app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());

// Basic health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Peptide Radar API Server with Mailchimp Running', 
    timestamp: new Date().toISOString(),
    features: {
      twilio: !!twilioClient,
      mailchimp: !!(process.env.MAILCHIMP_API_KEY),
      database: true
    }
  });
});

// ===== MAILCHIMP SERVICE =====
class MailchimpService {
  constructor() {
    this.listId = process.env.MAILCHIMP_AUDIENCE_ID;
    this.enabled = !!(process.env.MAILCHIMP_API_KEY && this.listId);
  }

  async addSubscriber(customer, tags = []) {
    if (!this.enabled || !customer.email) return;

    try {
      const subscriberData = {
        email_address: customer.email,
        status: 'subscribed',
        merge_fields: {
          FNAME: customer.firstName || '',
          LNAME: customer.lastName || '',
          PHONE: customer.phone || '',
          PLAN: customer.plan || 'free',
          SHOPIFY_ID: customer.shopifyCustomerId
        },
        tags: tags
      };

      const response = await mailchimp.lists.addListMember(this.listId, subscriberData);
      console.log(`Added customer ${customer.email} to Mailchimp`);
      return response;
    } catch (error) {
      if (error.status === 400 && error.response?.body?.title === 'Member Exists') {
        return this.updateSubscriber(customer, tags);
      }
      console.error('Mailchimp add subscriber error:', error.response?.body || error.message);
    }
  }

  async updateSubscriber(customer, tags = []) {
    if (!this.enabled || !customer.email) return;

    try {
      const subscriberHash = this.getSubscriberHash(customer.email);
      
      const updateData = {
        merge_fields: {
          FNAME: customer.firstName || '',
          LNAME: customer.lastName || '',
          PHONE: customer.phone || '',
          PLAN: customer.plan || 'free',
          SHOPIFY_ID: customer.shopifyCustomerId
        }
      };

      if (tags.length > 0) {
        updateData.tags = tags;
      }

      const response = await mailchimp.lists.updateListMember(
        this.listId, 
        subscriberHash, 
        updateData
      );
      
      console.log(`Updated customer ${customer.email} in Mailchimp`);
      return response;
    } catch (error) {
      console.error('Mailchimp update subscriber error:', error.response?.body || error.message);
    }
  }

  async tagSubscriber(email, tags) {
    if (!this.enabled || !email) return;

    try {
      const subscriberHash = this.getSubscriberHash(email);
      
      await mailchimp.lists.updateListMemberTags(this.listId, subscriberHash, {
        tags: tags.map(tag => ({ name: tag, status: 'active' }))
      });
      
      console.log(`Tagged ${email} with: ${tags.join(', ')}`);
    } catch (error) {
      console.error('Mailchimp tag subscriber error:', error.response?.body || error.message);
    }
  }

  async removeTag(email, tags) {
    if (!this.enabled || !email) return;

    try {
      const subscriberHash = this.getSubscriberHash(email);
      
      await mailchimp.lists.updateListMemberTags(this.listId, subscriberHash, {
        tags: tags.map(tag => ({ name: tag, status: 'inactive' }))
      });
      
      console.log(`Removed tags from ${email}: ${tags.join(', ')}`);
    } catch (error) {
      console.error('Mailchimp remove tag error:', error.response?.body || error.message);
    }
  }

  async sendWelcomeSequence(customer) {
    if (!this.enabled || !customer.email) return;

    try {
      await this.tagSubscriber(customer.email, ['new_customer', 'welcome_sequence']);
      console.log(`Triggered welcome sequence for ${customer.email}`);
    } catch (error) {
      console.error('Welcome sequence error:', error);
    }
  }

  async sendPremiumWelcome(customer) {
    if (!this.enabled || !customer.email) return;

    try {
      await this.tagSubscriber(customer.email, ['premium_customer', 'premium_welcome']);
      console.log(`Triggered premium welcome for ${customer.email}`);
    } catch (error) {
      console.error('Premium welcome error:', error);
    }
  }

  getSubscriberHash(email) {
    return require('crypto').createHash('md5').update(email.toLowerCase()).digest('hex');
  }

  async segmentCustomers() {
    if (!this.enabled) return;

    try {
      const customers = await prisma.customer.findMany({
        include: {
          dosageLogs: {
            where: {
              date: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
            }
          },
          calculations: {
            where: {
              date: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
            }
          }
        }
      });

      for (const customer of customers) {
        const tags = [];
        
        if (customer.plan === 'premium') {
          tags.push('premium_customer');
        } else {
          tags.push('free_customer');
        }

        const monthlyDoses = customer.dosageLogs.length;
        const monthlyCalcs = customer.calculations.length;
        
        if (monthlyDoses === 0 && monthlyCalcs === 0) {
          tags.push('inactive_user');
        } else if (monthlyDoses >= 10 || monthlyCalcs >= 5) {
          tags.push('active_user');
          if (customer.plan === 'free') {
            tags.push('high_usage');
          }
        } else {
          tags.push('moderate_user');
        }

        const weeklyDoses = customer.dosageLogs.filter(d => 
          new Date(d.date) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        ).length;
        
        if (weeklyDoses >= 5) {
          tags.push('consistent');
        }

        if (customer.email) {
          await this.updateSubscriber(customer, tags);
        }
      }

      console.log('Customer segmentation completed');
    } catch (error) {
      console.error('Customer segmentation error:', error);
    }
  }
}

const mailchimpService = new MailchimpService();

// ===== EMAIL SERVICE =====
class EmailService {
  constructor() {
    this.enabled = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
    
    if (this.enabled) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    }
  }

  async sendDoseReminder(customer, dose) {
    if (!this.enabled || !customer.email || !customer.emailNotifications) return;

    try {
      const subject = `💉 Dose Reminder: ${dose.peptide}`;
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8f9fa; padding: 20px;">
          <div style="background: #32ff32; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0;">⏰ Dose Reminder</h1>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px;">
            <h2>Hi ${customer.firstName}!</h2>
            <p>This is a friendly reminder for your scheduled dose:</p>
            
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #32ff32;">
              <h3 style="margin-top: 0; color: #32ff32;">📋 Dose Details:</h3>
              <p><strong>Peptide:</strong> ${dose.peptide}</p>
              <p><strong>Amount:</strong> ${dose.amount} ${dose.unit}</p>
              <p><strong>Scheduled Time:</strong> ${dose.dateTime.toLocaleString()}</p>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.SHOPIFY_STORE_URL}/pages/dashboard" 
                 style="background: #32ff32; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                Mark as Taken
              </a>
            </div>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: process.env.FROM_EMAIL,
        to: customer.email,
        subject,
        html
      });

      console.log(`Email reminder sent to customer ${customer.id}`);
    } catch (error) {
      console.error('Email send error:', error);
    }
  }

  async sendWeeklySummary(customer, stats) {
    if (!this.enabled || !customer.email || !customer.emailNotifications) return;

    try {
      const subject = '📊 Your Weekly Peptide Progress';
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #32ff32; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">📊 Weekly Progress Report</h1>
          </div>
          
          <div style="padding: 30px; background: white;">
            <h2>Hi ${customer.firstName}!</h2>
            <p>Here's your peptide tracking summary for this week:</p>
            
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0;">
              <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 2rem; color: #32ff32; margin-bottom: 5px;">${stats.dosesThisWeek}</div>
                <div style="font-size: 0.9rem; color: #666;">Doses Taken</div>
              </div>
              <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 2rem; color: #32ff32; margin-bottom: 5px;">${stats.compliance}%</div>
                <div style="font-size: 0.9rem; color: #666;">Compliance</div>
              </div>
              <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 2rem; color: #32ff32; margin-bottom: 5px;">${stats.weightChange}</div>
                <div style="font-size: 0.9rem; color: #666;">Weight Change</div>
              </div>
            </div>
          </div>
        </div>
      `;

      await this.transporter.sendMail({
        from: process.env.FROM_EMAIL,
        to: customer.email,
        subject,
        html
      });

      console.log(`Weekly summary sent to customer ${customer.id}`);
    } catch (error) {
      console.error('Weekly summary send error:', error);
    }
  }
}

const emailService = new EmailService();

// ===== SHOPIFY WEBHOOK VERIFICATION =====
const verifyShopifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = req.body;
  const hash = createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET || 'default_secret')
    .update(body, 'utf8')
    .digest('base64');

  if (hash !== hmac) {
    console.log('Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  req.body = JSON.parse(body);
  next();
};

// ===== SHOPIFY WEBHOOKS =====

app.post('/webhooks/customers/create', verifyShopifyWebhook, async (req, res) => {
  try {
    const customer = req.body;
    
    const savedCustomer = await prisma.customer.upsert({
      where: { shopifyCustomerId: customer.id.toString() },
      update: {
        email: customer.email,
        phone: customer.phone,
        firstName: customer.first_name,
        lastName: customer.last_name,
      },
      create: {
        shopifyCustomerId: customer.id.toString(),
        shopDomain: req.get('X-Shopify-Shop-Domain') || 'unknown',
        email: customer.email,
        phone: customer.phone,
        firstName: customer.first_name,
        lastName: customer.last_name,
      },
    });

    if (customer.email) {
      await mailchimpService.addSubscriber(savedCustomer, ['new_customer']);
      await mailchimpService.sendWelcomeSequence(savedCustomer);
    }

    console.log(`Customer ${customer.id} synced to database and Mailchimp`);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Customer webhook error:', error);
    res.status(500).send('Error');
  }
});

app.post('/webhooks/orders/create', verifyShopifyWebhook, async (req, res) => {
  try {
    const order = req.body;
    
    const hasPremium = order.line_items.some(item => 
      item.title.includes('Peptide Radar - Premium') ||
      item.sku === 'peptide-radar-premium'
    );

    if (hasPremium && order.customer) {
      const customer = await prisma.customer.findUnique({
        where: { shopifyCustomerId: order.customer.id.toString() }
      });

      if (customer) {
        const updatedCustomer = await prisma.customer.update({
          where: { id: customer.id },
          data: { plan: 'premium' }
        });

        await prisma.subscription.create({
          data: {
            customerId: customer.id,
            stripeSubscriptionId: `shopify_${order.id}`,
            status: 'active',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          }
        });

        if (customer.email) {
          await mailchimpService.updateSubscriber(updatedCustomer, ['premium_customer']);
          await mailchimpService.sendPremiumWelcome(updatedCustomer);
          await mailchimpService.removeTag(customer.email, ['free_customer']);
        }

        console.log(`Customer ${customer.id} upgraded to premium`);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Order webhook error:', error);
    res.status(500).send('Error');
  }
});

// ===== API ENDPOINTS =====

app.get('/api/customer/data', async (req, res) => {
  try {
    const customerId = req.get('X-Customer-ID');
    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID required' });
    }

    const customer = await prisma.customer.findFirst({
      where: { shopifyCustomerId: customerId },
      include: {
        peptides: true,
        dosageLogs: {
          orderBy: { date: 'desc' },
          take: 100
        },
        weightLogs: {
          orderBy: { date: 'desc' },
          take: 100
        },
        scheduledDoses: {
          where: {
            dateTime: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          },
          orderBy: { dateTime: 'asc' }
        },
        calculations: {
          orderBy: { date: 'desc' },
          take: 50
        }
      }
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({
      peptides: customer.peptides,
      dosageLogs: customer.dosageLogs,
      weightLogs: customer.weightLogs,
      scheduledDoses: customer.scheduledDoses,
      calculations: customer.calculations,
      settings: {
        emailNotifications: customer.emailNotifications,
        smsNotifications: customer.smsNotifications,
        quietHoursStart: customer.quietHoursStart,
        quietHoursEnd: customer.quietHoursEnd,
      }
    });
  } catch (error) {
    console.error('Get customer data error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/customer/data', async (req, res) => {
  try {
    const customerId = req.get('X-Customer-ID');
    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID required' });
    }

    const customer = await prisma.customer.findFirst({
      where: { shopifyCustomerId: customerId }
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const { peptides, dosageLogs, weightLogs, scheduledDoses, calculations, settings } = req.body;

    if (settings) {
      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          emailNotifications: settings.emailNotifications,
          smsNotifications: settings.smsNotifications,
          quietHoursStart: settings.quietHoursStart,
          quietHoursEnd: settings.quietHoursEnd,
        }
      });
    }

    if (peptides) {
      await prisma.peptide.deleteMany({ where: { customerId: customer.id } });
      if (peptides.length > 0) {
        await prisma.peptide.createMany({
          data: peptides.map(p => ({
            ...p,
            customerId: customer.id,
            dateAdded: new Date(p.dateAdded)
          })),
          skipDuplicates: true
        });
      }
    }

    if (dosageLogs) {
      const existingLogs = await prisma.dosageLog.findMany({
        where: { customerId: customer.id },
        select: { id: true }
      });
      const existingIds = new Set(existingLogs.map(l => l.id));
      
      const newLogs = dosageLogs.filter(log => !existingIds.has(log.id));
      if (newLogs.length > 0) {
        await prisma.dosageLog.createMany({
          data: newLogs.map(log => ({
            ...log,
            customerId: customer.id,
            date: new Date(log.date)
          })),
          skipDuplicates: true
        });

        if (customer.email && newLogs.length >= 3) {
          await mailchimpService.tagSubscriber(customer.email, ['active_user']);
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Save customer data error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== SMS SERVICE =====
class SMSService {
  constructor() {
    this.enabled = !!twilioClient;
  }

  async sendReminder(customer, dose) {
    if (!this.enabled || !customer.phone || !customer.smsNotifications) return;

    try {
      const message = `Hi ${customer.firstName}! 💉 Time for your ${dose.peptide} dose: ${dose.amount} ${dose.unit}. Reply TAKEN when done, DELAY30 to postpone, or SKIP to skip.`;
      
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: customer.phone
      });

      console.log(`SMS reminder sent to customer ${customer.id}`);
    } catch (error) {
      console.error('SMS send error:', error);
    }
  }

  async handleIncomingSMS(from, body, messageId) {
    if (!this.enabled) return;

    try {
      const customer = await prisma.customer.findFirst({
        where: { phone: from }
      });

      if (!customer) {
        await this.sendSMS(from, "Sorry, we couldn't find your account. Please contact support.");
        return;
      }

      const command = body.trim().toUpperCase();
      const response = await this.processCommand(customer.id, command);
      
      if (response) {
        await this.sendSMS(from, response);
      }
    } catch (error) {
      console.error('Handle incoming SMS error:', error);
    }
  }

  async processCommand(customerId, command) {
    const now = new Date();
    
    switch (command) {
      case 'TAKEN':
        await this.markDoseTaken(customerId, now);
        return "✅ Dose marked as taken! Great job staying on track.";
        
      case 'DELAY30':
        await this.delayNextReminder(customerId, 30);
        return "⏰ Reminder delayed by 30 minutes. We'll check back with you then.";
        
      case 'SKIP':
        await this.skipDose(customerId, now);
        return "⏭️ Dose skipped. No worries, just try to stay consistent when possible.";
        
      case 'STATUS':
        return await this.getStatusSummary(customerId);
        
      case 'HELP':
        return "Commands: TAKEN, DELAY30, SKIP, STATUS, STOP. Visit your dashboard for more options.";
        
      case 'STOP':
        await this.disableSMS(customerId);
        return "SMS notifications disabled. You can re-enable them in your dashboard.";
        
      default:
        return "I didn't understand that command. Reply HELP for available commands.";
    }
  }

  async markDoseTaken(customerId, timestamp) {
    const dose = await prisma.scheduledDose.findFirst({
      where: {
        customerId,
        dateTime: { lte: new Date(timestamp.getTime() + 30 * 60 * 1000) },
        status: 'scheduled'
      },
      orderBy: { dateTime: 'desc' }
    });

    if (dose) {
      await prisma.scheduledDose.update({
        where: { id: dose.id },
        data: { 
          status: 'taken',
          takenAt: timestamp
        }
      });

      await prisma.dosageLog.create({
        data: {
          customerId,
          peptide: dose.peptide,
          amount: dose.amount,
          unit: dose.unit,
          date: timestamp,
          source: 'sms'
        }
      });
    }
  }

  async sendSMS(to, message) {
    if (!this.enabled) return;

    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to
      });
    } catch (error) {
      console.error('Send SMS error:', error);
    }
  }
}

const smsService = new SMSService();

// Twilio webhook for incoming SMS
app.post('/webhooks/sms/incoming', async (req, res) => {
  try {
    const { From, Body, MessageSid } = req.body;
    await smsService.handleIncomingSMS(From, Body, MessageSid);
    
    res.set('Content-Type', 'text/xml');
    res.send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response></Response>
    `);
  } catch (error) {
    console.error('SMS webhook error:', error);
    res.status(500).send('Error');
  }
});

// ===== CRON JOBS =====

// Check for due reminders every minute
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const reminderWindow = new Date(now.getTime() + 5 * 60 * 1000);

    const dueReminders = await prisma.scheduledDose.findMany({
      where: {
        status: 'scheduled',
        dateTime: {
          gte: now,
          lte: reminderWindow
        },
        reminderSent: false
      },
      include: {
        customer: true
      }
    });

    for (const dose of dueReminders) {
      if (dose.emailNotification) {
        await emailService.sendDoseReminder(dose.customer, dose);
      }
      
      if (dose.textNotification && dose.customer.phone) {
        await smsService.sendReminder(dose.customer, dose);
      }

      await prisma.scheduledDose.update({
        where: { id: dose.id },
        data: { reminderSent: true }
      });
    }
  } catch (error) {
    console.error('Reminder cron error:', error);
  }
});

// Send weekly summaries every Sunday at 6 PM
cron.schedule('0 18 * * 0', async () => {
  try {
    const customers = await prisma.customer.findMany({
      where: {
        emailNotifications: true,
        email: { not: null }
      }
    });

    for (const customer of customers) {
      const stats = await getWeeklyStats(customer.id);
      await emailService.sendWeeklySummary(customer, stats);
    }
  } catch (error) {
    console.error('Weekly summary cron error:', error);
  }
});

// Daily Mailchimp segmentation
cron.schedule('0 2 * * *', async () => {
  try {
    console.log('Starting daily customer segmentation...');
    await mailchimpService.segmentCustomers();
  } catch (error) {
    console.error('Segmentation cron error:', error);
  }
});

// Mark missed doses
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    await prisma.scheduledDose.updateMany({
      where: {
        status: 'scheduled',
        dateTime: { lte: twoHoursAgo }
      },
      data: {
        status: 'missed'
      }
    });
  } catch (error) {
    console.error('Mark missed doses error:', error);
  }
});

// ===== UTILITY FUNCTIONS =====

async function getWeeklyStats(customerId) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  const [dosesThisWeek, totalScheduled, weightLogs] = await Promise.all([
    prisma.scheduledDose.count({
      where: {
        customerId,
        status: 'taken',
        takenAt: { gte: weekAgo }
      }
    }),
    prisma.scheduledDose.count({
      where: {
        customerId,
        dateTime: { gte: weekAgo, lte: new Date() }
      }
    }),
    prisma.weightLog.findMany({
      where: {
        customerId,
        date: { gte: weekAgo }
      },
      orderBy: { date: 'asc' },
      take: 2
    })
  ]);

  const compliance = totalScheduled > 0 ? Math.round((dosesThisWeek / totalScheduled) * 100) : 0;
  
  let weightChange = 'No data';
  if (weightLogs.length >= 2) {
    const first = weightLogs[0];
    const last = weightLogs[weightLogs.length - 1];
    const firstLbs = first.unit === 'kg' ? first.weight * 2.20462 : first.weight;
    const lastLbs = last.unit === 'kg' ? last.weight * 2.20462 : last.weight;
    const change = lastLbs - firstLbs;
    weightChange = (change >= 0 ? '+' : '') + change.toFixed(1) + ' lbs';
  }

  return {
    dosesThisWeek,
    compliance,
    weightChange
  };
}

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Peptide Radar API server with Mailchimp running on port ${PORT}`);
});

export default app;
