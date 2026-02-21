# Plan: Sistema Multi-Agente de IA para Jersey Pickles

## Arquitectura

### Antes (1 agente monolitico)
```
DecisionEngine → Claude (1 prompt gigante) → Decisiones de todo tipo
```

### Despues (4 agentes especializados)
```
AgentRunner (cron cada 30 min)
  ├── BudgetAgent     → Analiza distribucion de presupuesto
  ├── PerformanceAgent → Analiza ROAS/CPA por ad set
  ├── CreativeAgent    → Detecta fatiga creativa y de audiencia
  └── PacingAgent      → Analiza velocidad de gasto vs objetivo
        │
        ▼
  AgentReport (MongoDB) ← Cada agente guarda su analisis
        │
        ▼
  Frontend: Tarjetas por agente + Recomendaciones con boton Aprobar/Rechazar
```

## Los 4 Agentes

### 1. BudgetAgent (Presupuesto)
- **Que analiza**: Distribucion del budget entre ad sets, si hay ad sets con mucho/poco budget vs su rendimiento
- **Recomendaciones**: "BROAD 3 tiene ROAS 6.2x con solo $50/dia, subir a $60"
- **Prompt enfocado**: Solo recibe budgets + ROAS/CPA de cada ad set
- **Icono**: DollarSign (verde)

### 2. PerformanceAgent (Rendimiento)
- **Que analiza**: ROAS, CPA, tendencias 3d vs 7d, ad sets perdiendo dinero
- **Recomendaciones**: "BROAD 8 lleva 5 dias con ROAS < 1.0x, pausar"
- **Prompt enfocado**: Metricas de rendimiento, tendencias, historico
- **Icono**: TrendingUp (azul)

### 3. CreativeAgent (Fatiga Creativa)
- **Que analiza**: Frecuencia, CTR decay, audiencia saturada
- **Recomendaciones**: "HALF SOUR freq 3.8 y CTR bajando, audiencia fatigada"
- **Prompt enfocado**: Frecuencia, CTR, reach, impresiones
- **Icono**: Eye (naranja)

### 4. PacingAgent (Ritmo de Gasto)
- **Que analiza**: Velocidad de gasto vs objetivo diario, underpacing/overpacing
- **Recomendaciones**: "Cuenta al 45% del pacing a las 2pm, bajo ritmo"
- **Prompt enfocado**: Spend today, hora del dia, budget diario, pacing %
- **Icono**: Gauge (cyan)

## Cambios por Capa

### CAPA 1: Backend — Modelo AgentReport (nuevo)

**Archivo**: `src/db/models/AgentReport.js`

```
AgentReport {
  agent_type: 'budget' | 'performance' | 'creative' | 'pacing'
  cycle_id: string
  summary: string (resumen corto del agente)
  status: 'healthy' | 'warning' | 'critical'
  recommendations: [{
    id: ObjectId
    action: 'scale_up' | 'scale_down' | 'pause' | 'reactivate' | 'no_action'
    entity_type: 'adset'
    entity_id: string
    entity_name: string
    current_value: number
    recommended_value: number
    change_percent: number
    reasoning: string (explicacion en espanol)
    expected_impact: string (que esperamos que pase)
    confidence: 'high' | 'medium' | 'low'
    priority: 'critical' | 'high' | 'medium' | 'low'
    metrics: { roas_7d, roas_3d, cpa_7d, spend_today, frequency, ctr }
    status: 'pending' | 'approved' | 'rejected' | 'executed'
    approved_by: string (null hasta que se apruebe)
    approved_at: Date
    executed_at: Date
    execution_result: Mixed
  }]
  alerts: [{ type, message, severity }]
  prompt_tokens: number
  completion_tokens: number
  created_at: Date
}
```

### CAPA 2: Backend — Agent Runner (nuevo)

**Archivo**: `src/ai/agents/agent-runner.js`

Orquestador que ejecuta los 4 agentes secuencialmente (no en paralelo para no saturar Claude):

```javascript
class AgentRunner {
  async runAll() {
    // Cargar datos una sola vez (compartidos entre agentes)
    const data = await this.loadSharedData();

    // Ejecutar secuencialmente
    for (const Agent of [BudgetAgent, PerformanceAgent, CreativeAgent, PacingAgent]) {
      const agent = new Agent();
      await agent.analyze(data);
    }
  }
}
```

### CAPA 3: Backend — Cada Agente (nuevos)

Archivos:
- `src/ai/agents/base-agent.js` — Clase base con logica comun
- `src/ai/agents/budget-agent.js`
- `src/ai/agents/performance-agent.js`
- `src/ai/agents/creative-agent.js`
- `src/ai/agents/pacing-agent.js`

Cada agente:
1. Recibe los datos compartidos
2. Filtra solo lo relevante para su area
3. Construye un prompt especializado (corto, ~1500 tokens)
4. Llama a Claude
5. Parsea la respuesta (recomendaciones + resumen)
6. Guarda AgentReport en MongoDB

**Formato JSON de respuesta de cada agente:**
```json
{
  "summary": "Resumen de 1 linea",
  "status": "healthy | warning | critical",
  "recommendations": [
    {
      "action": "scale_up",
      "entity_id": "123",
      "entity_name": "BROAD 3",
      "current_value": 50,
      "recommended_value": 60,
      "reasoning": "ROAS 6.2x estable por 5 dias, puede escalar",
      "expected_impact": "Incremento de ~$10 en revenue diario",
      "confidence": "high",
      "priority": "medium"
    }
  ],
  "alerts": []
}
```

### CAPA 4: Backend — API Routes (nuevo)

**Archivo**: `src/dashboard/routes/agents.js`

Endpoints:
- `GET /api/agents/latest` — Ultimo reporte de cada agente (4 objetos)
- `GET /api/agents/history?agent_type=budget&limit=20` — Historial por agente
- `POST /api/agents/approve/:recommendationId` — Aprobar recomendacion
- `POST /api/agents/reject/:recommendationId` — Rechazar recomendacion
- `POST /api/agents/execute/:recommendationId` — Ejecutar recomendacion aprobada (llama a Meta API)
- `POST /api/agents/run` — Forzar ejecucion manual de agentes

### CAPA 5: Backend — Cron Job (modificar index.js)

Agregar nuevo cron job:
```javascript
// Cada 30 min: Ciclo de agentes IA (horas activas)
cron.schedule('*/30 * * * *', jobAgentCycle, {
  timezone: TIMEZONE,
  name: 'agent-cycle'
});
```

El job viejo `jobAIDecisionCycle` (cada hora) se mantiene pero se desactiva — solo corre si quieres el modo legacy.

### CAPA 6: Frontend — Nueva pagina Agents.jsx

**Archivo**: `src/dashboard/frontend/src/pages/Agents.jsx`

Layout:
```
[Header: "Agentes IA" + ultimo ciclo timestamp + boton "Ejecutar Ahora"]

[4 Tarjetas de Resumen en Grid 2x2]
  ┌─────────────────────┐  ┌─────────────────────┐
  │ $ Budget Agent      │  │ ↗ Performance Agent  │
  │ Status: Healthy     │  │ Status: Warning      │
  │ "Budget OK, BROAD 3 │  │ "3 ad sets con ROAS  │
  │  puede escalar"     │  │  < 1x por 3+ dias"   │
  │ 2 recomendaciones   │  │ 3 recomendaciones    │
  └─────────────────────┘  └─────────────────────┘
  ┌─────────────────────┐  ┌─────────────────────┐
  │ 👁 Creative Agent   │  │ ⏱ Pacing Agent      │
  │ Status: Healthy     │  │ Status: Healthy      │
  │ "Sin fatiga detecta-│  │ "Pacing al 92%, en   │
  │  da en audiencias"  │  │  ritmo para el dia"  │
  │ 0 recomendaciones   │  │ 1 recomendacion      │
  └─────────────────────┘  └─────────────────────┘

[Tabla: Recomendaciones Pendientes]
  Ad Set        | Agente      | Accion    | Cambio      | Razon                    | Impacto        | [Aprobar] [Rechazar]
  BROAD 3       | Budget      | Scale Up  | $50 → $60   | ROAS 6.2x estable 5d    | +$10 rev/dia   | [✓] [✗]
  BROAD 8       | Performance | Pausar    | —           | ROAS 0.6x por 5 dias    | Ahorra $30/dia | [✓] [✗]
  HALF SOUR     | Creative    | Scale Down| $80 → $65   | Freq 3.8, CTR cayendo   | Reduce fatiga  | [✓] [✗]

[Historial de Recomendaciones (aprobadas/rechazadas)]
```

### CAPA 7: Frontend — api.js (agregar funciones)

```javascript
export const getAgentReports = async () => api.get('/api/agents/latest');
export const getAgentHistory = async (agentType, limit) => api.get('/api/agents/history', { params: { agent_type: agentType, limit } });
export const approveRecommendation = async (id) => api.post(`/api/agents/approve/${id}`);
export const rejectRecommendation = async (id) => api.post(`/api/agents/reject/${id}`);
export const executeRecommendation = async (id) => api.post(`/api/agents/execute/${id}`);
export const runAgents = async () => api.post('/api/agents/run');
```

### CAPA 8: Frontend — App.jsx (agregar ruta)

- Agregar import de `AgentsPage`
- Agregar ruta `/agents`
- Agregar item en sidebar: `{ path: '/agents', icon: Bot, label: 'Agentes IA' }`
- Posicionar despues de "Ad Sets" y antes de "Decisiones IA"

## Orden de Implementacion

1. **AgentReport model** — Schema de MongoDB
2. **base-agent.js** — Clase base con Claude call + parseo
3. **4 agentes** — budget, performance, creative, pacing (prompts especializados)
4. **agent-runner.js** — Orquestador
5. **agents.js route** — API endpoints (latest, history, approve, reject, execute)
6. **server.js** — Registrar nueva ruta
7. **index.js** — Cron job cada 30 min
8. **api.js** — Funciones frontend
9. **Agents.jsx** — Pagina completa con tarjetas + tabla de recomendaciones
10. **App.jsx** — Ruta + sidebar
11. **Build + Test** — Rebuild frontend, restart server, verificar

## Costo Estimado

- 4 agentes × ~1500 tokens input + ~500 output = ~8000 tokens/ciclo
- Cada 30 min durante horas activas (6am-11pm = 17h = 34 ciclos)
- ~272,000 tokens/dia ≈ $0.80-1.20/dia con Claude Sonnet

## Decision Engine Legacy

El DecisionEngine actual (`src/ai/decision-engine.js`) NO se elimina. Se mantiene como modo legacy/fallback. El nuevo sistema de agentes es independiente.
