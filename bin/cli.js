#!/usr/bin/env node

const command = process.argv[2]

if (command === 'init') {
  const { initializeDatabase, closeDb } = await import('../src/db/init.js')
  initializeDatabase()
  console.log('Database initialized successfully.')
  closeDb()
} else if (command === 'start') {
  const { startServer } = await import('../src/server.js')
  await startServer()
} else {
  console.log(`lbbs-next — self-hosted message board

Usage:
  lbbs-next init    Initialize database
  lbbs-next start   Start the server`)
}
