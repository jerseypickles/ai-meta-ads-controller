require('dotenv').config();
const { MetaClient } = require('../src/meta/client');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../src/utils/logger');

async function testMetaAPI() {
  console.log('\n══════════════════════════════════════');
  console.log('  PRUEBA DE CONEXIÓN — META API');
  console.log('══════════════════════════════════════\n');

  const meta = new MetaClient();

  console.log(`  API Version: ${config.meta.apiVersion}`);
  console.log(`  Ad Account: ${config.meta.adAccountId}`);
  console.log(`  Token: ${config.meta.accessToken ? '***' + config.meta.accessToken.slice(-6) : 'NO CONFIGURADO'}\n`);

  if (!config.meta.accessToken || config.meta.accessToken === 'your_long_lived_token') {
    console.log('  ⚠️  Token de Meta no configurado. Configura META_ACCESS_TOKEN en .env\n');
    return false;
  }

  try {
    const result = await meta.verifyAccess();
    if (result.success) {
      console.log('  ✅ Conexión a Meta API exitosa');
      console.log(`  Usuario: ${result.user.name} (${result.user.id})`);
      console.log(`  Cuenta: ${result.account.name}`);
      console.log(`  Status: ${result.account.account_status === 1 ? 'Activa' : 'Inactiva'}`);
      console.log(`  Moneda: ${result.account.currency}`);
      console.log(`  Zona horaria: ${result.account.timezone_name}\n`);

      // Verificar salud del token
      const tokenHealth = await meta.checkTokenHealth();
      if (tokenHealth.valid) {
        console.log(`  Token válido — ${tokenHealth.daysLeft === Infinity ? 'No expira' : `Expira en ${tokenHealth.daysLeft} días`}`);
      } else {
        console.log(`  ⚠️  Token inválido o expirado`);
      }

      // Probar obtener campañas
      const campaigns = await meta.getCampaigns();
      console.log(`\n  Campañas encontradas: ${campaigns.length}`);
      campaigns.forEach(c => {
        console.log(`    - ${c.name} (${c.effective_status}) — Budget: ${c.daily_budget ? '$' + (parseInt(c.daily_budget) / 100) : 'Lifetime'}`);
      });

      return true;
    } else {
      console.log(`  ❌ Error: ${result.error}\n`);
      return false;
    }
  } catch (error) {
    console.log(`  ❌ Error de conexión: ${error.message}\n`);
    return false;
  }
}

async function testClaudeAPI() {
  console.log('\n══════════════════════════════════════');
  console.log('  PRUEBA DE CONEXIÓN — CLAUDE API');
  console.log('══════════════════════════════════════\n');

  console.log(`  Modelo: ${config.claude.model}`);
  console.log(`  API Key: ${config.claude.apiKey ? '***' + config.claude.apiKey.slice(-6) : 'NO CONFIGURADA'}\n`);

  if (!config.claude.apiKey || config.claude.apiKey === 'your_claude_api_key') {
    console.log('  ⚠️  API Key de Claude no configurada. Configura ANTHROPIC_API_KEY en .env\n');
    return false;
  }

  try {
    const anthropic = new Anthropic({ apiKey: config.claude.apiKey });

    const message = await anthropic.messages.create({
      model: config.claude.model,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: 'Responde solo con "OK" si puedes leer esto.'
      }]
    });

    const response = message.content[0].text;
    console.log(`  ✅ Conexión a Claude API exitosa`);
    console.log(`  Respuesta: ${response}`);
    console.log(`  Tokens usados: ${message.usage.input_tokens} input, ${message.usage.output_tokens} output\n`);
    return true;
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}\n`);
    return false;
  }
}

async function testMongoDB() {
  console.log('\n══════════════════════════════════════');
  console.log('  PRUEBA DE CONEXIÓN — MONGODB');
  console.log('══════════════════════════════════════\n');

  console.log(`  URI: ${config.mongodb.uri.replace(/\/\/.*@/, '//***@')}\n`);

  try {
    const db = require('../src/db/connection');
    await db.connect();
    const status = db.getStatus();
    console.log(`  ✅ Conexión a MongoDB exitosa`);
    console.log(`  Estado: ${status.connected ? 'Conectado' : 'Desconectado'}\n`);
    await db.disconnect();
    return true;
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    console.log(`  Asegúrate de que MongoDB está corriendo en la URI configurada.\n`);
    return false;
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  AI META ADS CONTROLLER              ║');
  console.log('║  Prueba de Conexiones                ║');
  console.log('╚══════════════════════════════════════╝');

  const results = {
    meta: await testMetaAPI(),
    claude: await testClaudeAPI(),
    mongodb: await testMongoDB()
  };

  console.log('\n══════════════════════════════════════');
  console.log('  RESUMEN');
  console.log('══════════════════════════════════════');
  console.log(`  Meta API:  ${results.meta ? '✅ OK' : '❌ FALLO'}`);
  console.log(`  Claude:    ${results.claude ? '✅ OK' : '❌ FALLO'}`);
  console.log(`  MongoDB:   ${results.mongodb ? '✅ OK' : '❌ FALLO'}`);

  const allPassed = Object.values(results).every(v => v);
  console.log(`\n  ${allPassed ? '🟢 Todo listo para operar' : '🟡 Hay servicios por configurar'}\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
