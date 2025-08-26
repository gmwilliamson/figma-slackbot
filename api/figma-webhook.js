// api/figma-webhook.js
import { WebClient } from '@slack/web-api';
import crypto from 'crypto';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Simple in-memory storage for throttling
const notificationHistory = new Map();

// Semantic commit types and their configurations
const COMMIT_TYPES = {
  feat: {
    emoji: '✨',
    label: 'Feature',
    color: '#28a745',
    notify: true,
    priority: 'high'
  },
  fix: {
    emoji: '🐛',
    label: 'Fix', 
    color: '#dc3545',
    notify: true,
    priority: 'medium'
  },
  update: {
    emoji: '🔄',
    label: 'Update',
    color: '#007bff', 
    notify: true,
    priority: 'medium'
  },
  patch: {
    emoji: '🩹',
    label: 'Patch',
    color: '#6f42c1',
    notify: false, // Only notify if forced
    priority: 'low'
  },
  docs: {
    emoji: '📚',
    label: 'Documentation',
    color: '#17a2b8',
    notify: false,
    priority: 'low'
  },
  style: {
    emoji: '💄',
    label: 'Style',
    color: '#e83e8c',
    notify: false,
    priority: 'low'
  },
  refactor: {
    emoji: '♻️',
    label: 'Refactor',
    color: '#fd7e14',
    notify: true,
    priority: 'medium'
  },
  perf: {
    emoji: '⚡',
    label: 'Performance',
    color: '#20c997',
    notify: true,
    priority: 'high'
  },
  test: {
    emoji: '🧪',
    label: 'Test',
    color: '#6c757d',
    notify: false,
    priority: 'low'
  },
  chore: {
    emoji: '🔧',
    label: 'Chore',
    color: '#6c757d',
    notify: false,
    priority: 'low'
  },
  breaking: {
    emoji: '💥',
    label: 'BREAKING CHANGE',
    color: '#dc3545',
    notify: true,
    priority: 'critical'
  }
};

// Configuration for your Figma libraries
const LIBRARY_CONFIG = {
  'FFGrhBbe4JRpbBIuvOPhNP': {
    name: 'TestLibrary',
    channel: '#test-figma-updates',
    rules: {
      alwaysNotify: ['feat', 'breaking', 'fix', 'update'],
      neverNotify: ['chore', 'docs', 'patch'],
      throttleMinutes: {
        critical: 0,
        high: 30,
        medium: 60,
        low: 120
      }
    }
  }
};

function parseSemanticCommit(description) {
  // Regex to match: type(scope): description or type: description
  // Examples: 
  // "feat(buttons): add hover states for primary buttons"
  // "fix: resolve alignment issue in navigation"
  // "breaking!: remove deprecated color tokens"
  
  const semanticRegex = /^(feat|fix|update|patch|docs|style|refactor|perf|test|chore|breaking)(\([^)]+\))?(!)?:\s*(.+)$/i;
  const match = description.trim().match(semanticRegex);
  
  if (!match) {
    return {
      isValid: false,
      raw: description,
      reason: 'Not a valid semantic commit format'
    };
  }
  
  const [, type, scope, forceFlag, message] = match;
  
  return {
    isValid: true,
    type: type.toLowerCase(),
    scope: scope ? scope.slice(1, -1) : null, // Remove parentheses
    isForced: !!forceFlag,
    message: message.trim(),
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
    // Still need to check throttling
    const throttleCheck = checkThrottling(fileKey, commitType.priority, rules);
    if (!throttleCheck.allowed) {
      return {
        should: false,
        reason: throttleCheck.reason
      };
    }
    
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
  
  // Check throttling for default notification types
  const throttleCheck = checkThrottling(fileKey, commitType.priority, rules);
  if (!throttleCheck.allowed) {
    return {
      should: false,
      reason: throttleCheck.reason
    };
  }
  
  return {
    should: true,
    reason: `Type '${type}' meets notification criteria`
  };
}

function checkThrottling(fileKey, priority, rules) {
  const now = Date.now();
  const lastNotification = notificationHistory.get(fileKey);
  const throttleMinutes = rules.throttleMinutes[priority] || 30;
  const throttleMs = throttleMinutes * 60 * 1000;
  
  if (lastNotification && (now - lastNotification) < throttleMs) {
    const remainingMinutes = Math.ceil((throttleMs - (now - lastNotification)) / 60000);
    return {
      allowed: false,
      reason: `Throttled (${priority} priority). Next notification in ${remainingMinutes} minutes`
    };
  }
  
  return { allowed: true };
}

async function sendSlackNotification({ library, fileKey, publishedBy, parsedCommit, reason }) {
  const figmaUrl = `https://www.figma.com/file/${fileKey}`;
  const { type, scope, message, commitType } = parsedCommit;
  
  // Create title with emoji and type
  const title = `${commitType.emoji} ${commitType.label}${scope ? ` (${scope})` : ''} - ${library.name}`;
  
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: title,
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${message}*`
      }
    }
  ];
  
  // Add priority indicator for high/critical items
  if (commitType.priority === 'critical') {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🚨 *BREAKING CHANGE* - This may require immediate attention`
      }
    });
  } else if (commitType.priority === 'high') {
    blocks.push({
      type: 'section', 
      text: {
        type: 'mrkdwn',
        text: `⚠️ *High Priority* - Review recommended`
      }
    });
  }
  
  // Context footer
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Published by *${publishedBy}* • <${figmaUrl}|View in Figma> • Type: \`${type}\` • ${reason}`
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
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ message: 'OK' });
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Verify webhook signature
    const signature = req.headers['x-figma-signature'];
    const webhookSecret = process.env.FIGMA_WEBHOOK_SECRET;
    
    if (!webhookSecret || !signature) {
      return res.status(401).json({ error: 'Authentication failed' });
    }
    
    const body = JSON.stringify(req.body);
    if (!verifyWebhookSignature(body, signature, webhookSecret)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // Parse webhook data
    const { event_type, file_key, file_name, description = '', triggered_by } = req.body;
    
    console.log(`📝 Received: ${event_type} for ${file_name}`);
    console.log(`💬 Description: "${description}"`);
    
    if (event_type !== 'LIBRARY_PUBLISH') {
      return res.status(200).json({ message: `Ignored ${event_type}` });
    }
    
    // Find library configuration
    const library = LIBRARY_CONFIG[file_key];
    if (!library) {
      console.log(`ℹ️  File ${file_key} not monitored`);
      return res.status(200).json({ message: 'File not monitored' });
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
      console.log(`🚫 Skipped: ${notificationCheck.reason}`);
      return res.status(200).json({
        success: true,
        message: `Skipped: ${notificationCheck.reason}`,
        parsed: parsedCommit
      });
    }
    
    // Send notification
    await sendSlackNotification({
      library,
      fileKey: file_key,
      publishedBy: triggered_by?.handle || 'Unknown',
      parsedCommit,
      reason: notificationCheck.reason
    });
    
    // Update throttling
    notificationHistory.set(file_key, Date.now());
    
    console.log(`✅ Sent notification for ${parsedCommit.type}: ${parsedCommit.message}`);
    
    return res.status(200).json({
      success: true,
      message: `Sent ${parsedCommit.type} notification`,
      parsed: parsedCommit
    });
    
  } catch (error) {
    console.error('💥 Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}