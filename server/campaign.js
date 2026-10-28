import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CAMPAIGN_ID = 'detty-dezemba-dec-2026';
export const POOL_SCHEMA = 'tiketi.pool.v2';
export const TOTAL_ENTRIES = 25;
export const TOTAL_WINNERS = 1;
export const TOTAL_FREE_SPINS = 4;
export const TOTAL_REWARDS = TOTAL_WINNERS + TOTAL_FREE_SPINS;
export const ENTRY_PRICE = 500;
export const MAX_ENTRIES_PER_PHONE = 3;
export const GENESIS_HASH = '0'.repeat(64);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  let national = digits;
  if (digits.startsWith('254')) national = `0${digits.slice(3)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) national = `0${digits}`;
  if (!/^0(?:7|1)\d{8}$/.test(national)) {
    throw new Error('Enter a valid Kenyan mobile number, for example 0712 345 678.');
  }
  return `254${national.slice(1)}`;
}

export function maskPhone(phone) {
  const normalized = String(phone || '');
  if (normalized.length < 6) return 'Hidden number';
  const prefix = normalized.startsWith('2541') ? '+254 1' : '+254 7';
  return `${prefix}•• ••• ${normalized.slice(-3)}`;
}

function secureShuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function poolPayload(state) {
  return {
    schema: POOL_SCHEMA,
    campaignId: state.campaignId,
    currency: 'KES',
    entryPrice: ENTRY_PRICE,
    totalEntries: TOTAL_ENTRIES,
    totalWinners: TOTAL_WINNERS,
    totalFreeSpins: TOTAL_FREE_SPINS,
    totalRewards: TOTAL_REWARDS,
    outcomes: state.pool,
    salt: state.poolSalt,
  };
}

export function computeCommitment(state) {
  return sha256(JSON.stringify(poolPayload(state)));
}

export function resultPayload(entry) {
  return {
    schema: 'tiketi.result.v1',
    chainIndex: entry.chainIndex,
    previousHash: entry.previousHash,
    receipt: entry.receipt,
    entryNumber: entry.entryNumber,
    outcome: entry.outcome,
    prize: entry.prize,
    spunAt: entry.spunAt,
  };
}

export function computeResultHash(entry) {
  return sha256(JSON.stringify(resultPayload(entry)));
}

export function paidEntries(state) {
  return state.entries
    .filter((entry) => entry.paymentStatus === 'paid')
    .sort((a, b) => a.entryNumber - b.entryNumber);
}

export function campaignStats(state) {
  const paid = paidEntries(state);
  const allocatedWins = paid.filter((entry) => entry.outcome === 'win').length;
  const allocatedFreeSpins = paid.filter((entry) => entry.outcome === 'free-spin').length;
  const entriesRemaining = TOTAL_ENTRIES - paid.length;
  const ticketsRemaining = TOTAL_WINNERS - allocatedWins;
  const freeSpinsRemaining = TOTAL_FREE_SPINS - allocatedFreeSpins;
  const rewardsRemaining = ticketsRemaining + freeSpinsRemaining;
  return {
    entriesUsed: paid.length,
    entriesRemaining,
    allocatedWins,
    allocatedFreeSpins,
    ticketsRemaining,
    freeSpinsRemaining,
    rewardsRemaining,
    currentPool: {
      winningEntries: ticketsRemaining,
      freeSpinEntries: freeSpinsRemaining,
      rewardEntries: rewardsRemaining,
      entries: entriesRemaining,
    },
  };
}

export function refreshCampaignStatus(state) {
  const stats = campaignStats(state);
  if (stats.entriesRemaining === 0 || stats.ticketsRemaining === 0) {
    if (state.acceptingEntries) state.closedAt = new Date().toISOString();
    state.acceptingEntries = false;
  }
  const paid = paidEntries(state);
  if (!state.acceptingEntries && paid.length > 0 && paid.every((entry) => entry.spinStatus === 'completed')) {
    state.poolRevealed = true;
    state.revealedAt ||= new Date().toISOString();
  }
  return state;
}

export function createCampaign({ seedDemo = false, seedCount = 10 } = {}) {
  const pool = secureShuffle([
    ...Array(TOTAL_WINNERS).fill('win'),
    ...Array(TOTAL_FREE_SPINS).fill('free-spin'),
    ...Array(TOTAL_ENTRIES - TOTAL_REWARDS).fill('no-win'),
  ]);

  // Seeded demo entries are non-winning so the hosted preview starts open.
  if (seedDemo) {
    for (let index = 0; index < seedCount; index += 1) {
      if (pool[index] === 'no-win') continue;
      const swapIndex = pool.findIndex((outcome, candidate) => candidate >= seedCount && outcome === 'no-win');
      [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
    }
  }

  // A free spin must always have a following position available for its bonus.
  if (pool[pool.length - 1] === 'free-spin') {
    const firstCandidate = seedDemo ? seedCount : 0;
    const swapIndex = pool.findIndex((outcome, candidate) => candidate >= firstCandidate && outcome === 'no-win');
    [pool[pool.length - 1], pool[swapIndex]] = [pool[swapIndex], pool[pool.length - 1]];
  }

  const now = Date.now();
  const state = {
    version: 2,
    poolSchema: POOL_SCHEMA,
    campaignId: CAMPAIGN_ID,
    createdAt: new Date(now - (seedDemo ? (seedCount + 2) * 8 * 60_000 : 0)).toISOString(),
    pool,
    poolSalt: crypto.randomBytes(32).toString('hex'),
    poolRevealed: false,
    revealedAt: null,
    acceptingEntries: true,
    closedAt: null,
    entries: [],
    ledgerHead: GENESIS_HASH,
    ledgerLength: 0,
  };
  state.commitment = computeCommitment(state);

  if (seedDemo) {
    for (let index = 0; index < seedCount; index += 1) {
      if (!state.acceptingEntries) break;
      const phone = `2547${String(10000000 + index * 7919).padStart(8, '0')}`;
      const createdAt = new Date(now - (seedCount - index + 1) * 8 * 60_000).toISOString();
      const entry = createPendingEntry(state, phone, createdAt);
      markEntryPaid(state, entry.id, {
        paidAt: new Date(Date.parse(createdAt) + 45_000).toISOString(),
        mpesaReceipt: `SIM${String(index + 1).padStart(6, '0')}`,
      });
      revealEntry(state, entry.id, new Date(Date.parse(createdAt) + 52_000).toISOString());
    }
    refreshCampaignStatus(state);
  }

  return state;
}

export function saveCampaign(state, dataFile) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryFile, dataFile);
}

export function loadOrCreateCampaign(dataFile, { demo = true } = {}) {
  const createFresh = () => {
    const fresh = createCampaign({ seedDemo: demo });
    saveCampaign(fresh, dataFile);
    return fresh;
  };

  if (fs.existsSync(dataFile)) {
    const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const compatible = state.campaignId === CAMPAIGN_ID
      && state.poolSchema === POOL_SCHEMA
      && state.pool?.length === TOTAL_ENTRIES;
    if (!compatible) {
      if (!demo) {
        throw new Error('The saved campaign uses an incompatible prize-pool schema. Use a new DATA_FILE or migrate it explicitly; live data was not changed.');
      }
      const archive = `${dataFile}.legacy-${Date.now()}`;
      fs.renameSync(dataFile, archive);
      console.warn(`Archived incompatible simulated campaign data at ${archive}; starting a fresh committed pool.`);
      return createFresh();
    }
    if (computeCommitment(state) !== state.commitment) {
      throw new Error('Campaign commitment verification failed. Refusing to alter the outcome pool.');
    }
    return state;
  }
  return createFresh();
}

export function createPendingEntry(state, phone, createdAt = new Date().toISOString()) {
  refreshCampaignStatus(state);
  if (!state.acceptingEntries) {
    throw new Error('This drop is closed. All available entries or tickets have been allocated.');
  }

  const normalized = normalizePhone(phone);
  const activeForPhone = state.entries.filter((entry) => {
    if (entry.bonusOf) return false;
    if (entry.phone !== normalized || entry.paymentStatus === 'failed') return false;
    if (entry.paymentStatus === 'paid') return true;
    return Date.now() - Date.parse(entry.createdAt) < 15 * 60_000;
  }).length;
  if (activeForPhone >= MAX_ENTRIES_PER_PHONE) {
    throw new Error(`This number has reached the ${MAX_ENTRIES_PER_PHONE}-entry limit for this drop.`);
  }

  const entry = {
    id: crypto.randomUUID(),
    phone: normalized,
    amount: ENTRY_PRICE,
    currency: 'KES',
    paymentStatus: 'pending',
    paymentMethod: 'M-Pesa',
    paymentReference: null,
    merchantRequestId: null,
    checkoutRequestId: null,
    bonusOf: null,
    freeSpinEntryId: null,
    failureReason: null,
    createdAt,
    paidAt: null,
    entryNumber: null,
    receipt: null,
    outcome: null,
    prize: null,
    spinStatus: 'locked',
    spunAt: null,
    chainIndex: null,
    previousHash: null,
    resultHash: null,
  };
  state.entries.push(entry);
  return entry;
}

export function markEntryPaid(state, entryId, { paidAt = new Date().toISOString(), mpesaReceipt = null } = {}) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) throw new Error('Entry not found.');
  if (entry.paymentStatus === 'paid') return entry;
  if (entry.paymentStatus === 'failed') throw new Error('This payment was not successful. Please start a new entry.');

  refreshCampaignStatus(state);
  if (!state.acceptingEntries) {
    throw new Error('The drop closed before this payment could be confirmed. Flag this payment for refund review.');
  }

  const position = paidEntries(state).length;
  if (position >= TOTAL_ENTRIES) throw new Error('The entry pool is full.');

  entry.paymentStatus = 'paid';
  entry.paidAt = paidAt;
  entry.paymentReference = mpesaReceipt;
  entry.entryNumber = position + 1;
  entry.receipt = `DD-${String(entry.entryNumber).padStart(4, '0')}`;
  entry.outcome = state.pool[position];
  entry.spinStatus = 'ready';
  entry.failureReason = null;
  refreshCampaignStatus(state);
  return entry;
}

function createFreeSpinEntry(state, parentEntry) {
  const existing = state.entries.find((item) => item.bonusOf === parentEntry.id);
  if (existing) {
    parentEntry.freeSpinEntryId = existing.id;
    return existing;
  }

  const position = paidEntries(state).length;
  if (position >= TOTAL_ENTRIES) throw new Error('No pool position remains for this free spin.');
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    phone: parentEntry.phone,
    amount: 0,
    currency: 'KES',
    paymentStatus: 'paid',
    paymentMethod: 'Free spin',
    paymentReference: `BONUS-${parentEntry.receipt}`,
    merchantRequestId: null,
    checkoutRequestId: null,
    bonusOf: parentEntry.id,
    freeSpinEntryId: null,
    failureReason: null,
    createdAt: now,
    paidAt: now,
    entryNumber: position + 1,
    receipt: `DD-${String(position + 1).padStart(4, '0')}`,
    outcome: state.pool[position],
    prize: null,
    spinStatus: 'ready',
    spunAt: null,
    chainIndex: null,
    previousHash: null,
    resultHash: null,
  };
  parentEntry.freeSpinEntryId = entry.id;
  state.entries.push(entry);
  return entry;
}

export function revealEntry(state, entryId, spunAt = new Date().toISOString()) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) throw new Error('Entry not found.');
  if (entry.paymentStatus !== 'paid') throw new Error('Payment must be confirmed before spinning.');
  if (entry.spinStatus === 'completed') return entry;

  entry.spinStatus = 'completed';
  entry.spunAt = spunAt;
  if (entry.outcome === 'win') {
    entry.prize = 'REGULAR TICKET 01';
  } else if (entry.outcome === 'free-spin') {
    entry.prize = 'FREE SPIN';
  }
  entry.chainIndex = state.ledgerLength;
  entry.previousHash = state.ledgerHead;
  entry.resultHash = computeResultHash(entry);
  state.ledgerHead = entry.resultHash;
  state.ledgerLength += 1;
  if (entry.outcome === 'free-spin') createFreeSpinEntry(state, entry);
  refreshCampaignStatus(state);
  return entry;
}

export function publicLedgerEntry(entry) {
  return {
    receipt: entry.receipt,
    entryNumber: entry.entryNumber,
    phone: maskPhone(entry.phone),
    outcome: entry.outcome,
    prize: entry.prize,
    paidAt: entry.paidAt,
    spunAt: entry.spunAt,
    chainIndex: entry.chainIndex,
    previousHash: entry.previousHash,
    resultHash: entry.resultHash,
  };
}

export function playerEntry(entry) {
  const completed = entry.spinStatus === 'completed';
  return {
    id: entry.id,
    bonusOf: entry.bonusOf || null,
    freeSpinEntryId: entry.freeSpinEntryId || null,
    paymentStatus: entry.paymentStatus,
    paymentMethod: entry.paymentMethod,
    paymentReference: entry.paymentReference,
    amount: entry.amount,
    currency: entry.currency,
    phone: maskPhone(entry.phone),
    createdAt: entry.createdAt,
    paidAt: entry.paidAt,
    failureReason: entry.failureReason,
    spinStatus: entry.spinStatus,
    receipt: entry.receipt,
    entryNumber: entry.entryNumber,
    outcome: completed ? entry.outcome : null,
    prize: completed ? entry.prize : null,
    spunAt: completed ? entry.spunAt : null,
    chainIndex: completed ? entry.chainIndex : null,
    previousHash: completed ? entry.previousHash : null,
    resultHash: completed ? entry.resultHash : null,
  };
}

export function publicCampaign(state) {
  const stats = campaignStats(state);
  const ledger = state.entries
    .filter((entry) => entry.spinStatus === 'completed')
    .sort((a, b) => b.chainIndex - a.chainIndex)
    .map(publicLedgerEntry);
  return {
    id: state.campaignId,
    title: 'Detty Dezemba Festival',
    prize: '1 Regular ticket + 4 Free Spins',
    entryPrice: ENTRY_PRICE,
    currency: 'KES',
    totalEntries: TOTAL_ENTRIES,
    totalWinners: TOTAL_WINNERS,
    totalFreeSpins: TOTAL_FREE_SPINS,
    totalRewards: TOTAL_REWARDS,
    maxEntriesPerPhone: MAX_ENTRIES_PER_PHONE,
    status: state.acceptingEntries ? 'open' : 'closed',
    entriesUsed: stats.entriesUsed,
    entriesRemaining: stats.entriesRemaining,
    ticketsRemaining: stats.ticketsRemaining,
    freeSpinsRemaining: stats.freeSpinsRemaining,
    rewardsRemaining: stats.rewardsRemaining,
    currentPool: stats.currentPool,
    startingOdds: `1 in ${TOTAL_ENTRIES / TOTAL_REWARDS}`,
    ticketOdds: `1 in ${TOTAL_ENTRIES / TOTAL_WINNERS}`,
    commitment: state.commitment,
    ledgerHead: state.ledgerHead,
    ledgerLength: state.ledgerLength,
    poolRevealed: state.poolRevealed,
    createdAt: state.createdAt,
    closedAt: state.closedAt,
    ledger,
  };
}

export function revealedPool(state) {
  if (!state.poolRevealed) throw new Error('The outcome pool will be revealed after the drop closes and all allocated spins, including Free Spins, are complete.');
  const payload = poolPayload(state);
  return {
    payload,
    commitment: state.commitment,
    algorithm: 'SHA-256 of JSON.stringify(payload)',
  };
}
