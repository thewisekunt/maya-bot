import mysql from 'mysql2/promise';
import { config } from './config.js';

// Single shared connection pool — reused across all messages
const pool = mysql.createPool({
  host:            config.db.host,
  port:            config.db.port,
  database:        config.db.database,
  user:            config.db.user,
  password:        config.db.password,
  charset:         'utf8mb4',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit:      0,
  timezone:        'Z',      // treat DB timestamps as UTC → correct JS Date objects
  dateStrings:     false,    // return actual Date objects, not strings
});

// Test connection at startup
pool.getConnection()
  .then(conn => { console.log('[db] MySQL connected ✓'); conn.release(); })
  .catch(err => { console.error('[db] Connection failed:', err.message); process.exit(1); });

export default pool;
