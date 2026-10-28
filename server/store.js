import pg from 'pg';
import {
  CAMPAIGN_ID,
  createCampaign,
  loadOrCreateCampaign,
  saveCampaign,
  validateCampaignState,
} from './campaign.js';

const { Pool } = pg;
const TABLE = 'detty_campaign_state';

export function postgresConfigured(env = process.env) {
  return Boolean(env.DATABASE_URL || env.POSTGRES_URL);
}

function connectionSettings(connectionString) {
  const local = /(?:localhost|127\.0\.0\.1)/.test(connectionString);
  return {
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    ssl: local ? undefined : { rejectUnauthorized: false },
  };
}

async function createPostgresStore({ connectionString, paymentMode, storageKey }) {
  const pool = new Pool(connectionSettings(connectionString));
  const key = storageKey || `${CAMPAIGN_ID}:${paymentMode}`;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const fresh = createCampaign({ seedDemo: paymentMode === 'demo' });
  await pool.query(
    `INSERT INTO ${TABLE} (id, state) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING`,
    [key, JSON.stringify(fresh)],
  );

  async function read() {
    const result = await pool.query(`SELECT state FROM ${TABLE} WHERE id = $1`, [key]);
    if (!result.rows[0]) throw new Error('Stored campaign was not found.');
    return validateCampaignState(result.rows[0].state);
  }

  async function transact(mutator) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT state FROM ${TABLE} WHERE id = $1 FOR UPDATE`, [key]);
      if (!result.rows[0]) throw new Error('Stored campaign was not found.');
      const state = validateCampaignState(result.rows[0].state);
      const value = await mutator(state);
      await client.query(
        `UPDATE ${TABLE} SET state = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [key, JSON.stringify(state)],
      );
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    kind: 'postgres',
    persistent: true,
    storageKey: key,
    read,
    transact,
    close: () => pool.end(),
  };
}

function createJsonStore({ dataFile, paymentMode, isVercel }) {
  let state = loadOrCreateCampaign(dataFile, { demo: paymentMode === 'demo' });
  let queue = Promise.resolve();

  return {
    kind: isVercel ? 'ephemeral-demo' : 'local-json',
    persistent: !isVercel,
    read: async () => state,
    transact(mutator) {
      const run = queue.then(async () => {
        const draft = structuredClone(state);
        const value = await mutator(draft);
        saveCampaign(draft, dataFile);
        state = draft;
        return value;
      });
      queue = run.catch(() => {});
      return run;
    },
    close: async () => {},
  };
}

export async function createCampaignStore({
  dataFile,
  paymentMode,
  isVercel = false,
  connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL,
  storageKey,
}) {
  if (connectionString) return createPostgresStore({ connectionString, paymentMode, storageKey });
  return createJsonStore({ dataFile, paymentMode, isVercel });
}
