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
    emoji: '💥',
    label: 'BREAKING',
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
        normal: 60
      }
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
  
  // Match the first line for type and components/scope
  const semanticRegex = /^(feat|fix|update|patch|docs|style|refactor|perf|test|chore|breaking)(\([^)]+\))?(!)?:\s*(.+)$/i;
  const match = firstLine.match(semanticRegex);
  
  if (!match) {
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
  
  // Check if priority flag is set anywhere in the description
  const hasPriorityFlag = /\bpriority\b/i.test(description);
  
  // Set priority based on type and flags
  let priority = 'normal';
  if (type.toLowerCase() === 'breaking') {
    priority = 'critical'; // Breaking changes are always critical for throttling
  } else if (hasPriorityFlag) {
    priority = 'high'; // Any priority flag gets high priority for throttling
  }

  return {
    isValid: true,
    type: type.toLowerCase(),
    scope: scope ? scope.slice(1, -1) : null, // Remove parentheses
    components: components,
    bulletPoints: bulletPoints,
    isForced: !!forceFlag,
    priority: priority,
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
    // Still need to check throttling
    const throttleCheck = checkThrottling(fileKey, parsedCommit.priority, rules);
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
  const throttleCheck = checkThrottling(fileKey, parsedCommit.priority, rules);
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
  const throttleMinutes = rules.throttleMinutes[priority] || rules.throttleMinutes['normal'] || 60;
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
  const { type, scope, message, components, bulletPoints, commitType } = parsedCommit;
  
  // Create title with emoji and type as a large markdown section
  let title = `*${commitType.emoji} ${commitType.label}`;
  if (scope) {
    title += ` (${scope})`;
  } else if (components && components.length > 0) {
    const formattedComponents = components.map(comp => `\`${comp}\``).join(', ');
    title += `: ${formattedComponents}`;
  }
  title += ` - ${library.name}*`;
  
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: title
      }
    }
  ];
  
  // Add priority indicator for breaking changes and priority flags (before content)
  if (parsedCommit.type === 'breaking') {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🚨 *BREAKING CHANGE*`
      }
    });
  } else if (/\bpriority\b/i.test(parsedCommit.raw)) {
    blocks.push({
      type: 'section', 
      text: {
        type: 'mrkdwn',
        text: `⚠️ *PLEASE REVIEW*`
      }
    });
  }
  
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
  
  // Context footer
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Published by *${publishedBy}* • <${figmaUrl}|View in Figma>`
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