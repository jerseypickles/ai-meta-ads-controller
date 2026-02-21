require('dotenv').config();
const db = require('../src/db/connection');
const DataCollector = require('../src/meta/data-collector');
const logger = require('../src/utils/logger');

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  BACKFILL DE MÉTRICAS HISTÓRICAS     ║');
  console.log('╚══════════════════════════════════════╝\n');

  try {
    await db.connect();
    console.log('MongoDB conectado\n');

    const collector = new DataCollector();

    console.log('Iniciando recolección de métricas actuales...\n');
    const result = await collector.collect();

    console.log('\n══════════════════════════════════════');
    console.log('  RESULTADO');
    console.log('══════════════════════════════════════');
    console.log(`  Campañas procesadas: ${result.campaigns}`);
    console.log(`  Snapshots guardados: ${result.snapshots}`);
    console.log(`  Tiempo: ${result.elapsed}`);
    console.log('══════════════════════════════════════\n');

  } catch (error) {
    console.error('Error en backfill:', error.message);
    logger.error('Backfill falló:', error);
  } finally {
    await db.disconnect();
    process.exit(0);
  }
}

main();
