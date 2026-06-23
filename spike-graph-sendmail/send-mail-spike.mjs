#!/usr/bin/env node
/**
 * Spike: send meeting notes via Graph Mail.Send (delegated, user's own mailbox).
 *
 * Usage:
 *   npm install
 *   copy .env.example .env   # fill AZURE_AD_* and TEST_RECIPIENTS
 *   npm run spike:dry-run    # auth + filter only, no send
 *   npm run spike            # auth + send test email with attachment
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import axios from 'axios';
import { PublicClientApplication } from '@azure/msal-node';
import {
  ALLOWED_EMAIL_DOMAIN,
  filterInternalRecipients,
  parseRecipientList,
} from './recipient-filter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read'];
const CACHE_FILE = path.join(__dirname, '.msal-token-cache.json');

const dryRun = process.argv.includes('--dry-run');

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

function loadTokenCache(pca) {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      pca.getTokenCache().deserialize(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {
    console.warn('[spike] Could not load token cache — fresh sign-in required.');
  }
}

function saveTokenCache(pca) {
  try {
    fs.writeFileSync(CACHE_FILE, pca.getTokenCache().serialize(), 'utf8');
  } catch (err) {
    console.warn('[spike] Could not persist token cache:', err.message);
  }
}

async function acquireAccessToken(tenantId, clientId) {
  const pca = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });

  loadTokenCache(pca);
  const accounts = await pca.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const silent = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
      if (silent?.accessToken) {
        saveTokenCache(pca);
        return { accessToken: silent.accessToken, account: accounts[0] };
      }
    } catch {
      console.log('[spike] Silent token failed — starting device code sign-in.');
    }
  }

  const deviceCodeRequest = {
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.log('\n--- Sign in (device code) ---');
      console.log(response.message);
      console.log('Grant Mail.Send when prompted.\n');
    },
  };

  const result = await pca.acquireTokenByDeviceCode(deviceCodeRequest);
  if (!result?.accessToken) {
    throw new Error('Device code sign-in did not return an access token.');
  }

  saveTokenCache(pca);
  const refreshedAccounts = await pca.getTokenCache().getAllAccounts();
  return { accessToken: result.accessToken, account: refreshedAccounts[0] ?? null };
}

async function getSignedInProfile(accessToken) {
  const { data } = await axios.get(`${GRAPH_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { $select: 'displayName,mail,userPrincipalName' },
  });
  const email = data.mail || data.userPrincipalName;
  if (!email) throw new Error('Could not resolve signed-in user email from Graph /me.');
  return { displayName: data.displayName ?? email, email };
}

function buildAttachment(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const name = path.basename(filePath);
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name,
    contentType: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
    contentBytes: Buffer.from(content, 'utf8').toString('base64'),
  };
}

function toGraphRecipients(recipients) {
  return recipients.map((r) => ({
    emailAddress: {
      address: r.email,
      name: r.name ?? r.email,
    },
  }));
}

async function sendMail(accessToken, message) {
  await axios.post(
    `${GRAPH_BASE}/me/sendMail`,
    { message, saveToSentItems: true },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
  );
}

async function main() {
  const tenantId = requireEnv('AZURE_AD_TENANT_ID');
  const clientId = requireEnv('AZURE_AD_CLIENT_ID');

  const rawRecipients = process.env.TEST_RECIPIENTS?.trim();
  if (!rawRecipients) {
    console.error('Missing TEST_RECIPIENTS in .env (comma-separated emails).');
    process.exit(1);
  }

  const attachmentPath = path.resolve(
    __dirname,
    process.env.ATTACHMENT_PATH?.trim() || 'sample-meeting-notes.md',
  );
  if (!fs.existsSync(attachmentPath)) {
    console.error(`Attachment not found: ${attachmentPath}`);
    process.exit(1);
  }

  console.log('Graph Mail.Send spike');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no email sent)' : 'LIVE SEND'}`);
  console.log(`Allowed domain: @${ALLOWED_EMAIL_DOMAIN}\n`);

  const { accessToken, account } = await acquireAccessToken(tenantId, clientId);
  const profile = await getSignedInProfile(accessToken);
  console.log(`Signed in as: ${profile.displayName} <${profile.email}>`);
  if (account?.username) console.log(`MSAL account: ${account.username}`);

  const invitees = parseRecipientList(rawRecipients);
  const { allowed, rejected } = filterInternalRecipients(invitees);

  console.log('\nRecipient filter:');
  console.log(`  Input invitees: ${invitees.length}`);
  console.log(`  Allowed (@${ALLOWED_EMAIL_DOMAIN}): ${allowed.length}`);
  for (const r of allowed) console.log(`    ✓ ${r.email}`);
  console.log(`  Rejected (external/invalid): ${rejected.length}`);
  for (const r of rejected) console.log(`    ✗ ${r.email || '(empty)'}`);

  if (allowed.length === 0) {
    console.error('\nNo allowed recipients after domain filter. Aborting.');
    process.exit(1);
  }

  const attachment = buildAttachment(attachmentPath);
  const attachmentBytes = Buffer.from(attachment.contentBytes, 'base64').length;

  const message = {
    subject: `[Notetaker spike] Meeting notes — ${new Date().toISOString().slice(0, 10)}`,
    body: {
      contentType: 'HTML',
      content: [
        '<p>This is a <strong>Graph Mail.Send spike</strong> from the Notetaker project.</p>',
        `<p>Simulated meeting notes are attached (<code>${attachment.name}</code>).</p>`,
        `<p>Only <code>@${ALLOWED_EMAIL_DOMAIN}</code> addresses were included in To.</p>`,
        `<p>Sent by: ${profile.displayName} &lt;${profile.email}&gt;</p>`,
      ].join('\n'),
    },
    toRecipients: toGraphRecipients(allowed),
    attachments: [attachment],
  };

  console.log('\nPrepared message:');
  console.log(`  Subject: ${message.subject}`);
  console.log(`  To: ${allowed.map((r) => r.email).join(', ')}`);
  console.log(`  Attachment: ${attachment.name} (${attachmentBytes} bytes)`);

  if (dryRun) {
    console.log('\nDry run complete — no email sent.');
    console.log('Run `npm run spike` to send for real.');
    return;
  }

  await sendMail(accessToken, message);
  console.log('\n✓ sendMail succeeded. Check Outlook Sent Items and recipient inboxes.');
}

main().catch((err) => {
  if (axios.isAxiosError(err)) {
    console.error('\nGraph API error:');
    console.error(`  Status: ${err.response?.status}`);
    console.error(`  Body:`, JSON.stringify(err.response?.data, null, 2));
    if (err.response?.status === 403) {
      console.error('\nHint: Add delegated Mail.Send to the app registration and re-consent.');
    }
  } else {
    console.error('\nSpike failed:', err.message ?? err);
  }
  process.exit(1);
});
