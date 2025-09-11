// api/figma-webhook.js
import { WebClient } from '@slack/web-api';
import crypto from 'crypto';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Request deduplication cache
const requestCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

// Rate limiting per file key
const rateLimitCache = new Map();
const RATE_LIMIT_WINDOW = 30 * 1000; // 30 seconds
const MAX_REQUESTS_PER_WINDOW = 5; // Max 5 requests per file per 30 seconds

// Message tracking for potential deletion
const sentMessages = new Map(); // requestId -> { channel, timestamp, messageId }

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now();
  
  // Clean deduplication cache
  for (const [key, timestamp] of requestCache.entries()) {
    if (now - timestamp > CACHE_DURATION) {
      requestCache.delete(key);
    }
  }
  
  // Clean rate limit cache
  for (const [fileKey, requests] of rateLimitCache.entries()) {
    const validRequests = requests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
    if (validRequests.length === 0) {
      rateLimitCache.delete(fileKey);
    } else {
      rateLimitCache.set(fileKey, validRequests);
    }
  }
  
  // Clean sent messages cache (keep for 24 hours)
  const MESSAGE_RETENTION = 24 * 60 * 60 * 1000; // 24 hours
  for (const [requestId, messageData] of sentMessages.entries()) {
    if (now - messageData.sentAt > MESSAGE_RETENTION) {
      sentMessages.delete(requestId);
    }
  }
}, 60 * 1000); // Clean every minute

// Generate a unique request identifier based on webhook content
function generateRequestId(fileKey, description, triggeredBy, timestamp) {
  const content = `${fileKey}-${description.trim()}-${triggeredBy}-${Math.floor(timestamp / 10000)}`; // Round to 10 second intervals
  return crypto.createHash('md5').update(content).digest('hex');
}

// Check if this request is a duplicate
function isDuplicateRequest(requestId) {
  const now = Date.now();
  
  if (requestCache.has(requestId)) {
    const previousTimestamp = requestCache.get(requestId);
    const timeDiff = now - previousTimestamp;
    
    console.log(`🔄 Duplicate request detected: ${requestId} (${timeDiff}ms ago)`);
    return true;
  }
  
  // Store this request
  requestCache.set(requestId, now);
  console.log(`🆕 New request: ${requestId}`);
  return false;
}

// Check rate limiting for a file key
function checkRateLimit(fileKey) {
  const now = Date.now();
  
  if (!rateLimitCache.has(fileKey)) {
    rateLimitCache.set(fileKey, []);
  }
  
  const requests = rateLimitCache.get(fileKey);
  const validRequests = requests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);
  
  if (validRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    console.log(`🚨 Rate limit exceeded for ${fileKey}: ${validRequests.length} requests in last ${RATE_LIMIT_WINDOW/1000}s`);
    return false;
  }
  
  // Add current request
  validRequests.push(now);
  rateLimitCache.set(fileKey, validRequests);
  console.log(`📊 Rate limit check passed for ${fileKey}: ${validRequests.length}/${MAX_REQUESTS_PER_WINDOW} requests`);
  
  return true;
}

// Semantic commit types and their configurations
const COMMIT_TYPES = {
  feat: {
    emoji: '✨',
    label: 'Feature',
    notify: true
  },
  fix: {
    emoji: '🐛',
    label: 'Fix', 
    notify: true
  },
  update: {
    emoji: '🔄',
    label: 'Update',
    notify: true
  },
  patch: {
    emoji: '🩹',
    label: 'Patch',
    notify: false // Only notify if forced
  },
  docs: {
    emoji: '📚',
    label: 'Documentation',
    notify: false
  },
  style: {
    emoji: '💄',
    label: 'Style',
    notify: false
  },
  refactor: {
    emoji: '♻️',
    label: 'Refactor',
    notify: true
  },
  perf: {
    emoji: '⚡',
    label: 'Performance',
    notify: true
  },
  test: {
    emoji: '🧪',
    label: 'Test',
    notify: false
  },
  chore: {
    emoji: '🔧',
    label: 'Chore',
    notify: false
  },
  breaking: {
    emoji: '🚨',
    label: 'BREAKING',
    notify: true,
    priority: 'critical'
  }
};

// Mention mappings (groups and individuals)
const MENTION_GROUPS = {
  // User groups
  'designers': '<!subteam^S01LM83PSGZ>',    // @designers  
  'everyone': '<!everyone>',                // @everyone
  'channel': '<!channel>',                  // @channel
  'here': '<!here>',                        // @here
  
  // Individual users (add your team members)
  'greg': '<@U093TFW55N2>',                 // Greg's user ID
};

// Configuration for your Figma libraries
const LIBRARY_CONFIG = {
  'FFGrhBbe4JRpbBIuvOPhNP': {
    name: 'TestLibrary',
    channel: '#test-figma-updates',
    rules: {
      alwaysNotify: ['feat', 'breaking', 'fix', 'update'],
      neverNotify: ['chore', 'docs', 'patch']
    }
  },
  'S2aPy6GYy0dID7NvarJrSV': {
    name: '01. Foundations',
    channel: '#xfn-ds-fabric-updates',
    rules: {
      alwaysNotify: ['feat', 'breaking', 'fix', 'update', 'refactor'],
      neverNotify: ['perf', 'patch', 'docs', 'test', 'chore', 'style']
    }
  },
  'HnYrd6FfB4O1VUV9GuuWe6': {
    name: '02. Components',
    channel: '#xfn-ds-fabric-updates',
    rules: {
      alwaysNotify: ['feat', 'breaking', 'fix', 'update', 'refactor'],
      neverNotify: ['perf', 'patch', 'docs', 'test', 'chore', 'style']
    }
  }
};

function parseSemanticCommit(description) {
  // Enhanced regex to match multiple formats:
  // 1. type(scope): description
  // 2. type: Component1, Component2, Component3
  //    - bullet point 1
  //    - bullet point 2
  // 3. type: description
  // 4. breaking!: description
  
  const lines = description.trim().split('\n');
  const firstLine = lines[0].trim();
  
  // Debug logging
  console.log('🔍 Parsing description:', JSON.stringify(description));
  console.log('🔍 First line:', JSON.stringify(firstLine));
  
  // Match the first line for type and components/scope
  const semanticRegex = /^(feat|fix|update|patch|docs|style|refactor|perf|test|chore|breaking)(\([^)]+\))?(!)?:\s*(.+)$/i;
  const match = firstLine.match(semanticRegex);
  
  console.log('🔍 Regex match:', match);
  
  if (!match) {
    console.log('❌ Parse failed:', 'Not a valid semantic commit format');
    return {
      isValid: false,
      raw: description,
      reason: 'Not a valid semantic commit format'
    };
  }
  
  const [, type, scope, forceFlag, afterColon] = match;
  
  // Parse components and bullet points
  let components = [];
  let bulletPoints = [];
  let message = afterColon.trim();
  
  // Check if afterColon looks like a component list (comma-separated, no sentence structure)
  const componentListRegex = /^[A-Z][a-zA-Z0-9]*(?:\s*,\s*[A-Z][a-zA-Z0-9]*)*$/;
  if (componentListRegex.test(afterColon.trim())) {
    // Parse as component list
    components = afterColon.split(',').map(c => c.trim()).filter(c => c);
    
    // Parse bullet points from remaining lines
    bulletPoints = lines.slice(1)
      .map(line => line.trim())
      .filter(line => line.startsWith('-') || line.startsWith('•'))
      .map(line => line.replace(/^[-•]\s*/, '').trim())
      .filter(line => line);
    
    // Create a summary message
    if (bulletPoints.length > 0) {
      message = bulletPoints[0]; // Use first bullet as main message
    } else {
      message = `Updated ${components.join(', ')}`;
    }
  }
  
  // Check if priority flag is set anywhere in the description (requires brackets)
  const hasPriorityFlag = /\[priority\]/i.test(description);
  
  // Check if development is complete
  const isDevComplete = /\[dev-complete\]/i.test(description);
  
  // Parse mentions (e.g., [@designers], [@developers], [@everyone])
  const mentionMatches = description.match(/\[@([^\]]+)\]/g);
  const mentions = mentionMatches ? mentionMatches.map(match => match.slice(2, -1).toLowerCase()) : [];
  
  // Keep priority for message formatting only
  let priority = 'normal';
  if (type.toLowerCase() === 'breaking') {
    priority = 'critical';
  } else if (hasPriorityFlag) {
    priority = 'high';
  }

  return {
    isValid: true,
    type: type.toLowerCase(),
    scope: scope ? scope.slice(1, -1) : null, // Remove parentheses
    components: components,
    bulletPoints: bulletPoints,
    isForced: !!forceFlag,
    priority: priority,
    isDevComplete: isDevComplete,
    mentions: mentions,
    message: message,
    raw: description,
    commitType: COMMIT_TYPES[type.toLowerCase()]
  };
}

function shouldSendNotification(parsedCommit, rules, fileKey) {
  // If not a valid semantic commit, skip
  if (!parsedCommit.isValid) {
    return {
      should: false,
      reason: parsedCommit.reason
    };
  }
  
  const { type, isForced, commitType } = parsedCommit;
  
  // Force flag (!) always sends notification
  if (isForced) {
    return {
      should: true,
      reason: `Forced notification with ! flag`
    };
  }
  
  // Check if type is in neverNotify list
  if (rules.neverNotify?.includes(type)) {
    return {
      should: false,
      reason: `Type '${type}' is in never notify list`
    };
  }
  
  // Check if type is in alwaysNotify list
  if (rules.alwaysNotify?.includes(type)) {
    return {
      should: true,
      reason: `Type '${type}' is in always notify list`
    };
  }
  
  // Default behavior based on commit type configuration
  if (!commitType.notify) {
    return {
      should: false,
      reason: `Type '${type}' is configured to not notify by default`
    };
  }
  
  return {
    should: true,
    reason: `Type '${type}' meets notification criteria`
  };
}



async function deleteSlackMessage(channel, timestamp) {
  try {
    const result = await slack.chat.delete({
      channel: channel,
      ts: timestamp
    });
    
    if (result.ok) {
      console.log(`🗑️  Successfully deleted message ${timestamp} from ${channel}`);
      return result;
    } else {
      console.error(`❌ Failed to delete message: ${result.error}`);
      return null;
    }
  } catch (error) {
    console.error('❌ Error deleting Slack message:', error);
    return null;
  }
}

// Delete a message by request ID
async function deleteMessageByRequestId(requestId) {
  const messageData = sentMessages.get(requestId);
  if (!messageData) {
    console.log(`❌ No message found for request ID: ${requestId}`);
    console.log(`📊 Current stored messages: ${sentMessages.size}`);
    return { success: false, reason: 'Message not found in cache', details: `RequestId ${requestId} not tracked` };
  }
  
  console.log(`🔍 Found message for ${requestId}:`, messageData);
  
  const result = await deleteSlackMessage(messageData.channel, messageData.timestamp);
  if (result) {
    sentMessages.delete(requestId);
    console.log(`✅ Deleted and removed message for request ID: ${requestId}`);
    return { success: true, reason: 'Message deleted successfully' };
  }
  
  return { success: false, reason: 'Slack deletion failed', details: 'Message exists but could not be deleted from Slack' };
}

// Get all sent messages (for debugging/management)
function getSentMessages() {
  return Array.from(sentMessages.entries()).map(([requestId, data]) => ({
    requestId,
    ...data
  }));
}

// Get sent message by request ID
function getSentMessage(requestId) {
  return sentMessages.get(requestId);
}

async function sendSlackNotification({ library, fileKey, publishedBy, parsedCommit, reason, requestId }) {
  const figmaUrl = `https://www.figma.com/file/${fileKey}`;
  const { type, scope, message, components, bulletPoints, commitType, isDevComplete, mentions } = parsedCommit;
  
  // Create title with emoji and type as a large markdown section
  let title = `*${commitType.emoji} ${commitType.label}`;
  if (scope) {
    title += ` (${scope})`;
  } else if (components && components.length > 0) {
    const formattedComponents = components.map(comp => `\`${comp}\``).join(', ');
    title += `: ${formattedComponents}`;
  }
  
  title += `*`;
  
  const blocks = [];
  
  // Check if this is a priority message (priority flag or breaking change)
  const isPriority = parsedCommit.type === 'breaking' || /\[priority\]/i.test(parsedCommit.raw);
  
  // Build mentions array starting with priority mentions
  let allMentions = [];
  
  // Add automatic priority mention if this is a priority message
  if (isPriority) {
    allMentions.push(`${MENTION_GROUPS['designers']} - ⚠️ PLEASE REVIEW ⚠️`);
  }
  
  // Add explicit mentions from the commit message
  if (mentions && mentions.length > 0) {
    const explicitMentions = mentions
      .map(mention => MENTION_GROUPS[mention] || `@${mention}`)
      .join(' ');
    allMentions.push(explicitMentions);
  }
  
  // Add all mentions at the very top if any exist
  if (allMentions.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: allMentions.join('\n')
      }
    });
  }
  
  // Add the main title
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: title
    }
  });
  
  // If we have bullet points, show them as a list
  if (bulletPoints && bulletPoints.length > 0) {
    const bulletText = bulletPoints.map(point => `• ${point}`).join('\n');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: bulletText
      }
    });
  } else {
    // Fallback to regular message display
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${message}*`
      }
    });
  }
  
  // Context footer with status
  const designStatus = '`🟢 Design`';
  const devStatus = isDevComplete ? '`🟢 Development`' : '`🟡 Development`';
  
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Published by *${publishedBy}* in *${library.name}* • <${figmaUrl}|View in Figma> • ${designStatus} ${devStatus}`
      }
    ]
  });
  
  const message_payload = {
    channel: library.channel,
    text: `${commitType.emoji} ${commitType.label}: ${message}`,
    blocks: blocks,
    // Add color coding based on priority
    attachments: [{
      color: commitType.color,
      blocks: []
    }]
  };
  
  try {
    const result = await slack.chat.postMessage(message_payload);
    console.log(`✅ Sent ${type} notification:`, result.ts);
    
    // Store message details for potential deletion
    if (requestId && result.ok) {
      sentMessages.set(requestId, {
        channel: library.channel,
        timestamp: result.ts,
        messageId: result.ts,
        sentAt: Date.now(),
        fileKey: fileKey,
        commitType: type
      });
      console.log(`📝 Stored message ${result.ts} for potential deletion with requestId: ${requestId}`);
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error sending Slack message:', error);
    throw error;
  }
}

function verifyWebhookSignature(body, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  
  return signature === expectedSignature;
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const requestTimestamp = new Date().toISOString();
  
  console.log(`\n🔄 [${requestTimestamp}] New ${req.method} request received`);
  
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ message: 'OK' });
  }
  
  // Handle DELETE requests for message deletion
  if (req.method === 'DELETE') {
    const { requestId, channel, timestamp } = req.query;
    
    // Option 1: Delete by requestId (existing functionality)
    if (requestId) {
      const result = await deleteMessageByRequestId(requestId);
      
      if (result.success) {
        return res.status(200).json({ 
          success: true, 
          message: `Message with requestId ${requestId} deleted successfully`,
          reason: result.reason
        });
      } else {
        const statusCode = result.reason === 'Message not found in cache' ? 404 : 500;
        return res.status(statusCode).json({ 
          success: false, 
          message: `Message with requestId ${requestId} could not be deleted`,
          reason: result.reason,
          details: result.details,
          totalMessages: sentMessages.size
        });
      }
    }
    
    // Option 2: Delete by channel + timestamp (direct deletion)
    if (channel && timestamp) {
      const result = await deleteSlackMessage(channel, timestamp);
      
      if (result) {
        return res.status(200).json({ 
          success: true, 
          message: `Message ${timestamp} deleted successfully from ${channel}`,
          channel: channel,
          timestamp: timestamp
        });
      } else {
        return res.status(500).json({ 
          success: false, 
          message: `Failed to delete message ${timestamp} from ${channel}`,
          channel: channel,
          timestamp: timestamp
        });
      }
    }
    
    return res.status(400).json({ 
      error: 'Either requestId or both channel and timestamp query parameters required' 
    });
  }
  
  // Handle GET requests for listing sent messages (debugging)
  if (req.method === 'GET') {
    const { requestId } = req.query;
    
    if (requestId) {
      const message = getSentMessage(requestId);
      if (message) {
        return res.status(200).json({ message });
      } else {
        return res.status(404).json({ error: 'Message not found' });
      }
    }
    
    const messages = getSentMessages();
    return res.status(200).json({ messages });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Verify webhook using passcode in body instead of signature header
    const webhookSecret = process.env.FIGMA_WEBHOOK_SECRET;
    const providedPasscode = req.body.passcode;
    
    if (!webhookSecret || !providedPasscode) {
      console.log('Missing webhook secret or passcode');
      return res.status(401).json({ error: 'Authentication failed' });
    }
    
    if (providedPasscode !== webhookSecret) {
      console.log('Passcode verification failed');
      return res.status(401).json({ error: 'Invalid passcode' });
    }
    
    // Parse webhook data
    const { event_type, file_key, file_name, description = '', triggered_by } = req.body;
    
    console.log(`📝 Received: ${event_type} for ${file_name}`);
    console.log(`💬 Description: "${description}"`);
    console.log(`🔍 Full webhook payload:`, JSON.stringify(req.body, null, 2));
    
    // Generate request ID and check for duplicates
    const requestId = generateRequestId(
      file_key, 
      description, 
      triggered_by?.handle || 'unknown',
      Date.now()
    );
    
    if (isDuplicateRequest(requestId)) {
      const processingTime = Date.now() - startTime;
      console.log(`🚫 [${requestTimestamp}] Ignoring duplicate request: ${requestId} (${processingTime}ms)`);
      return res.status(200).json({ 
        success: true,
        message: 'Duplicate request ignored',
        requestId,
        processingTime: `${processingTime}ms`
      });
    }
    
    // Check rate limiting
    if (!checkRateLimit(file_key)) {
      const processingTime = Date.now() - startTime;
      console.log(`🚫 [${requestTimestamp}] Rate limit exceeded for ${file_key} (${processingTime}ms)`);
      return res.status(429).json({ 
        success: false,
        message: `Rate limit exceeded: too many requests for ${file_key}`,
        requestId,
        processingTime: `${processingTime}ms`
      });
    }
    
    if (event_type !== 'LIBRARY_PUBLISH') {
      const processingTime = Date.now() - startTime;
      console.log(`ℹ️  [${requestTimestamp}] Ignored ${event_type} (${processingTime}ms)`);
      return res.status(200).json({ 
        message: `Ignored ${event_type}`,
        requestId,
        processingTime: `${processingTime}ms`
      });
    }
    
    // Find library configuration
    const library = LIBRARY_CONFIG[file_key];
    if (!library) {
      const processingTime = Date.now() - startTime;
      console.log(`ℹ️  [${requestTimestamp}] File ${file_key} not monitored (${processingTime}ms)`);
      return res.status(200).json({ 
        message: 'File not monitored',
        requestId,
        processingTime: `${processingTime}ms`
      });
    }
    
    // Parse semantic commit
    const parsedCommit = parseSemanticCommit(description);
    console.log(`🔍 Parsed commit:`, parsedCommit);
    
    // Check if notification should be sent
    const notificationCheck = shouldSendNotification(
      parsedCommit,
      library.rules,
      file_key
    );
    
    if (!notificationCheck.should) {
      const processingTime = Date.now() - startTime;
      console.log(`🚫 [${requestTimestamp}] Skipped: ${notificationCheck.reason} (${processingTime}ms)`);
      return res.status(200).json({
        success: true,
        message: `Skipped: ${notificationCheck.reason}`,
        parsed: parsedCommit,
        requestId,
        processingTime: `${processingTime}ms`
      });
    }
    
    // Send notification
    await sendSlackNotification({
      library,
      fileKey: file_key,
      publishedBy: triggered_by?.handle || 'Unknown',
      parsedCommit,
      reason: notificationCheck.reason,
      requestId: requestId
    });
    

    
    const processingTime = Date.now() - startTime;
    console.log(`✅ [${requestTimestamp}] Sent notification for ${parsedCommit.type}: ${parsedCommit.message}`);
    console.log(`⏱️  Processing completed in ${processingTime}ms`);
    
    return res.status(200).json({
      success: true,
      message: `Sent ${parsedCommit.type} notification`,
      parsed: parsedCommit,
      requestId,
      processingTime: `${processingTime}ms`
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`💥 [${requestTimestamp}] Error after ${processingTime}ms:`, error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      processingTime: `${processingTime}ms`
    });
  }
}