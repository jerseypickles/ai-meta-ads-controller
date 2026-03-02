module.exports = {
  version: 'meta_delivery_priors_v2026_03',
  updated_at: '2026-03-02',

  // ═══════════════════════════════════════════════════════════════
  // PRINCIPIOS FUNDAMENTALES
  // Condensed delivery knowledge used as priors by the adaptive scorer.
  // ═══════════════════════════════════════════════════════════════
  principles: [
    'Meta optimiza por valor total de subasta (puja + probabilidad de accion + calidad).',
    'La fase de aprendizaje incrementa varianza; cambios agresivos aumentan riesgo.',
    'La calidad creativa y la fatiga de audiencia impactan rendimiento antes que el budget.',
    'Mayor incertidumbre de datos requiere acciones mas conservadoras.',
    'Attribution lag hace que datos recientes (<3 dias) subestimen rendimiento real.',
    'Auction overlap entre ad sets degrada eficiencia de la cuenta completa.',
    'El volumen de conversiones por ad set determina la estabilidad de la optimization.',
    'Incrementos de budget >20% pueden resetear la learning phase.'
  ],

  // ═══════════════════════════════════════════════════════════════
  // ACTION PRIORS — baselines para el adaptive scorer
  // ═══════════════════════════════════════════════════════════════
  action_priors: {
    scale_up: {
      baseline_impact_pct: 7.5,
      baseline_risk: 0.42,
      measurement_window_hours: 72
    },
    scale_down: {
      baseline_impact_pct: 5.0,
      baseline_risk: 0.28,
      measurement_window_hours: 72
    },
    pause: {
      baseline_impact_pct: 8.5,
      baseline_risk: 0.20,
      measurement_window_hours: 72
    },
    reactivate: {
      baseline_impact_pct: 6.5,
      baseline_risk: 0.35,
      measurement_window_hours: 72
    }
  },

  entity_modifiers: {
    adset: {
      growth_multiplier: 1.0,
      efficiency_multiplier: 1.0,
      risk_offset: 0.0
    },
    ad: {
      growth_multiplier: 0.85,
      efficiency_multiplier: 1.15,
      risk_offset: -0.04
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // AUCTION & DELIVERY SYSTEM
  // Conocimiento profundo de como Meta entrega ads
  // ═══════════════════════════════════════════════════════════════
  auction_mechanics: {
    total_value_formula: 'Advertiser Bid x Estimated Action Rate x Ad Quality Score',
    components: {
      bid: {
        description: 'Cuanto esta dispuesto a pagar el anunciante por la accion objetivo',
        types: ['lowest_cost', 'cost_cap', 'bid_cap', 'minimum_roas'],
        notes: [
          'Lowest cost (auto-bid) es el default y busca maximo volumen al menor costo',
          'Cost cap mantiene CPA promedio debajo del cap pero reduce volumen',
          'Bid cap pone limite duro por subasta individual — mas restrictivo',
          'Minimum ROAS es ideal para ecommerce con valores de pedido variables'
        ]
      },
      estimated_action_rate: {
        description: 'Probabilidad estimada de que el usuario realice la accion objetivo',
        factors: [
          'Historial de comportamiento del usuario',
          'Historial de rendimiento del ad',
          'Senales contextuales (hora, dispositivo, placement)',
          'Categoria de producto e historial de compras'
        ],
        notes: [
          'Meta actualiza esta prediccion en tiempo real durante la learning phase',
          'Ads nuevos tienen alta incertidumbre — Meta explora mostrando a audiencias variadas',
          'Ads con historial largo tienen predicciones mas estables pero pueden estancarse'
        ]
      },
      ad_quality: {
        description: 'Score de calidad basado en feedback positivo/negativo del ad',
        factors: [
          'Engagement rate (likes, comments, shares, saves)',
          'Negative feedback (hide, report, unfollow)',
          'Post-click experience (landing page, load time, bounce rate)',
          'Conversion rate post-click',
          'Text overlay percentage en imagenes',
          'Relevance diagnostics (quality ranking, engagement ranking, conversion ranking)'
        ],
        impact: 'Un ad con quality score alto puede ganar la subasta con bid mas bajo'
      }
    },
    delivery_patterns: {
      daily: [
        'Delivery no es lineal: puede gastar 0% en la manana y compensar agresivamente en tarde/noche',
        'Meta tiene periodos de alta competencia (8-10pm local) donde CPM sube 20-40%',
        'Fin de semana tipicamente tiene CPM mas bajo pero conversion rate variable',
        'El ultimo dia del mes/trimestre tiene CPM mas alto por anunciantes agotando presupuesto'
      ],
      weekly: [
        'Lunes-martes: CPM moderado, buen volume de inventory',
        'Miercoles-jueves: CPM estable, rendimiento consistente',
        'Viernes: CPM sube por competencia de weekend deals',
        'Sabado-domingo: CPM mas bajo pero intent de compra variable por vertical'
      ]
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // LEARNING PHASE
  // Todo lo que necesitas saber sobre la learning phase de Meta
  // ═══════════════════════════════════════════════════════════════
  learning_phase: {
    description: 'Periodo donde Meta optimiza el delivery del ad set recolectando datos',
    requirements: {
      conversions_needed: 50,
      time_window_days: 7,
      notes: [
        'Se necesitan ~50 optimization events en 7 dias para salir de learning',
        'Si no alcanza 50 conversiones, queda en "learning limited"',
        'Cada ad set tiene su propia learning phase independiente'
      ]
    },
    triggers_reset: [
      'Cambio de budget >20% (o segun la significancia estadistica de Meta)',
      'Edicion de targeting (audiencia, edad, genero, ubicacion)',
      'Edicion de placement (Instagram vs Facebook vs Audience Network)',
      'Cambio de optimization event (view content → purchase)',
      'Nuevo creativo agregado al ad set',
      'Pausa y reactivacion despues de 7+ dias',
      'Cambio de bid strategy'
    ],
    best_practices: [
      'No hacer cambios agresivos durante learning phase (esperar 7 dias)',
      'Si el ad set esta en learning limited, considerar consolidar con otros',
      'Budget minimo recomendado: CPA objetivo x 50 / 7 = budget diario minimo',
      'Avoid making more than 1 significant edit per ad set per week',
      'Para ads de Purchase, budget diario minimo de ~7x CPA target',
      '2025 update: Wait 7+ days before making ANY changes to a new ad set',
      '2025 update: Adding new ads to an ad set may NOT trigger learning reset (Meta updated this)',
      '2025 update: Batch all edits into a single change rather than multiple small changes over days',
      '2025 update: Scale budget gradually (max 20% every 2-3 days) to avoid resetting learning'
    ],
    learning_limited: {
      description: 'El ad set no logro 50 conversiones en 7 dias',
      causes: [
        'Budget demasiado bajo para el CPA target',
        'Audiencia demasiado estrecha',
        'Optimization event demasiado profundo (purchase vs add_to_cart)',
        'Creativos de baja calidad reducen engagement'
      ],
      solutions: [
        'Aumentar budget a minimo 7x CPA target',
        'Ampliar audiencia (usar Advantage+ o broad targeting)',
        'Considerar optimizar para evento mas arriba del funnel',
        'Consolidar ad sets con audiencias similares',
        'Mejorar calidad creativa para mejorar engagement'
      ]
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // ATTRIBUTION & MEASUREMENT
  // Ventanas, limitaciones, y como interpretar datos correctamente
  // ═══════════════════════════════════════════════════════════════
  attribution: {
    windows: {
      default: '7-day click, 1-day view',
      available: ['1-day click', '7-day click', '1-day click + 1-day view', '7-day click + 1-day view'],
      notes: [
        'View-through (1-day view) puede inflar ROAS 15-30% — Meta se atribuye ventas que habrian ocurrido organicamente',
        'Click-through es mas confiable pero subestima el impacto real',
        'Para comparaciones, usar siempre la misma ventana de atribucion'
      ]
    },
    data_lag: {
      description: 'Las conversiones se reportan con delay — datos recientes estan incompletos',
      typical_delay_hours: '4-72',
      stabilization_rules: [
        'Datos de "hoy" solo son ~60-70% completos al final del dia',
        'Datos de 3 dias estan ~85-90% completos',
        'Datos de 7 dias estan ~95%+ completos',
        'ROAS real de un periodo se estabiliza ~10 dias despues del fin del periodo',
        'Nunca tomar decisiones basadas solo en datos de hoy o ayer'
      ],
      implication: 'Comparar 7d vs 14d es mas confiable que 3d vs 7d para tendencias reales'
    },
    ios_impact: {
      description: 'iOS 14.5+ App Tracking Transparency redujo datos de conversion',
      effects: [
        'Modeled conversions: Meta estima conversiones que no puede verificar directamente',
        'Up to 30% de conversiones pueden ser modeladas (estimadas)',
        'Aggregated Event Measurement limita a 8 optimization events por dominio',
        'Reporting puede tener delay adicional de 24-48h para conversiones modeladas'
      ],
      mitigation: [
        'Conversions API (CAPI) para enviar eventos server-side — CRITICO para accuracy',
        'Si CAPI no esta implementado, ROAS reportado puede subestimar 20-40%',
        'UTM parameters como backup para rastreo',
        'Usar "7-day click" window que es menos afectado por restricciones de privacy'
      ]
    },
    cross_device: {
      notes: [
        'Meta tiene fuerte capacidad de cross-device tracking via logged-in users',
        'Una persona puede ver el ad en mobile y comprar en desktop — Meta lo atribuye correctamente',
        'Esto es una ventaja sobre plataformas que dependen solo de cookies'
      ]
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // ACCOUNT STRUCTURE & ORGANIZATION
  // Best practices para estructura de campanas
  // ═══════════════════════════════════════════════════════════════
  account_structure: {
    campaign_types: {
      abo: {
        name: 'Ad Set Budget Optimization',
        description: 'Cada ad set tiene su propio presupuesto',
        pros: ['Control granular por ad set', 'Mejor para testing', 'Predecible'],
        cons: ['Requiere mas gestion manual', 'No redistribuye budget automaticamente'],
        best_for: 'Cuentas en crecimiento, testing de audiencias'
      },
      cbo: {
        name: 'Campaign Budget Optimization',
        description: 'Meta distribuye el budget entre ad sets automaticamente',
        pros: ['Meta optimiza distribucion', 'Menos gestion', 'Mejor para escalar'],
        cons: ['Menos control', 'Puede concentrar spend en 1-2 ad sets', 'Dificil de diagnosticar'],
        best_for: 'Cuentas maduras con audiencias probadas'
      },
      asc: {
        name: 'Advantage+ Shopping Campaign',
        description: 'Campanas totalmente automatizadas para ecommerce',
        pros: ['Maxima automatizacion', 'Usa ML avanzado de Meta', 'Combina prospecting + retargeting'],
        cons: ['Minimo control de audiencias', 'Caja negra', 'Requiere volumen de creativos'],
        best_for: 'Ecommerce con 50+ conversiones/semana y 10+ creativos',
        minimum_budget: '$100/dia recomendado',
        creative_requirements: 'Minimo 10 variantes, idealmente 15-20'
      }
    },
    consolidation_rules: [
      'Menos ad sets con mas budget > muchos ad sets con poco budget',
      'Cada ad set necesita suficiente budget para generar ~50 conversiones en 7 dias',
      'Fragmentacion: muchos ad sets con <$30/dia cada uno = pobre optimization',
      'Ideal: 3-6 ad sets activos por campana',
      'Consolidar ad sets que compiten por la misma audiencia (auction overlap)',
      'Si dos ad sets tienen audience overlap >30%, considerar consolidar'
    ],
    naming_conventions: {
      campaign: '[Objetivo] - [Tipo] - [Fecha]',
      adset: '[Audiencia] - [Placement] - [Optimization]',
      ad: '[Formato] - [Angulo] - [Version]',
      examples: [
        'PURCHASE - ABO - 2026-Q1',
        'Broad_25-65_US - All_Placements - Purchase',
        'Video_SocialProof_v3'
      ]
    },
    signals: {
      needs_more_adsets: [
        'Solo 1-2 ad sets activos (concentracion de riesgo)',
        'ROAS consistente >4x por 14+ dias (oportunidad de expansion)',
        'Budget alto ($500+/dia) en un solo ad set (deberia diversificar)',
        'Una sola audiencia/angulo de messaging (falta testing)'
      ],
      needs_fewer_adsets: [
        'Muchos ad sets con <$30/dia (fragmentacion)',
        'Multiples ad sets con audience overlap alto',
        'Varios ad sets en "learning limited"',
        'Ad sets redundantes con misma audiencia y creativos similares'
      ],
      needs_new_ads: [
        'Ad set con <3 ads activos',
        'Frequency >2.5 con CTR bajando',
        'Todos los ads tienen el mismo angulo de messaging',
        'Ningun ad nuevo en las ultimas 2 semanas',
        'Top ad concentra >70% del spend del ad set'
      ]
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // CREATIVE STRATEGY
  // Framework completo de estrategia creativa
  // ═══════════════════════════════════════════════════════════════
  creative_strategy: {
    framework: {
      description: 'Creative es el #1 driver de rendimiento en Meta Ads',
      golden_rules: [
        'Volume + Variety > Perfection — testear muchas variaciones',
        'Cada ad set necesita 3-5+ variantes activas',
        'Diversificar angulos de messaging: no repetir el mismo mensaje',
        'Refresh creativos cada 2-3 semanas para combatir fatiga',
        'El primer segundo de video o la imagen principal determinan el 80% del engagement'
      ]
    },
    messaging_angles: {
      description: 'Diferentes perspectivas para vender el mismo producto',
      angles: {
        price_value: {
          description: 'Enfasis en precio, ofertas, valor por dinero',
          triggers: ['descuento', 'oferta', 'gratis', 'ahorra', 'precio', 'deal'],
          example_headline: 'Premium Pickles — Now 20% Off Your First Order',
          best_for: 'Nuevos clientes, price-sensitive audiences'
        },
        social_proof: {
          description: 'Reviews, testimonios, popularidad',
          triggers: ['review', 'stars', 'customers', 'rated', 'loved by', 'best seller'],
          example_headline: '10,000+ Happy Customers Cant Be Wrong',
          best_for: 'Building trust, cold audiences'
        },
        quality_craft: {
          description: 'Enfasis en calidad, ingredientes, proceso artesanal',
          triggers: ['artisanal', 'handcrafted', 'small batch', 'premium', 'natural', 'organic'],
          example_headline: 'Small-Batch Pickles Made the Old-Fashioned Way',
          best_for: 'Premium positioning, food enthusiasts'
        },
        urgency_scarcity: {
          description: 'Tiempo limitado, stock limitado, exclusividad',
          triggers: ['limited', 'hurry', 'last chance', 'only', 'ending', 'today only'],
          example_headline: 'Limited Batch — Only 500 Jars Available This Month',
          best_for: 'Driving immediate action, retargeting'
        },
        benefit_focused: {
          description: 'Beneficios del producto para el consumidor',
          triggers: ['perfect for', 'enjoy', 'taste', 'transform', 'experience'],
          example_headline: 'The Perfect Crunch for Every BBQ This Summer',
          best_for: 'Connecting product to customer lifestyle'
        },
        story_brand: {
          description: 'Historia de la marca, origen, mision',
          triggers: ['family', 'tradition', 'story', 'recipe', 'generation', 'jersey'],
          example_headline: 'From Our Family Kitchen in Jersey to Your Table',
          best_for: 'Brand building, emotional connection'
        },
        gift_occasion: {
          description: 'Producto como regalo o para ocasiones especiales',
          triggers: ['gift', 'perfect for', 'holiday', 'birthday', 'basket', 'set'],
          example_headline: 'The Gift Every Pickle Lover Dreams Of',
          best_for: 'Seasonal campaigns, gifting seasons, higher AOV'
        },
        problem_solution: {
          description: 'Problema del cliente que el producto resuelve',
          triggers: ['tired of', 'sick of', 'finally', 'no more', 'stop'],
          example_headline: 'Tired of Bland, Store-Bought Pickles? We Got You.',
          best_for: 'Differentiation from mass-market competitors'
        }
      },
      minimum_diversity: 3,
      ideal_diversity: 5,
      rule: 'Cada ad set debe tener al menos 3 angulos diferentes de messaging activos'
    },
    formats: {
      static_image: {
        pros: 'Facil de producir, bueno para messaging claro',
        cons: 'Menos engaging que video',
        best_practices: [
          'Producto en uso (lifestyle) > producto aislado',
          'Texto minimo en la imagen — dejar que headline/body hagan el trabajo',
          'Colores vibrantes y alto contraste para scroll-stopping',
          'Formato 1:1 para feed, 9:16 para Stories/Reels'
        ]
      },
      carousel: {
        pros: 'Ideal para mostrar multiples productos o contar una historia',
        cons: 'Requiere mas assets, no todos swipean',
        best_practices: [
          'Primera carta debe ser la mas atractiva (hook)',
          'Contar una historia progresiva entre cartas',
          'Cada carta puede tener headline diferente',
          'Ideal para product collections, paso-a-paso, before/after'
        ]
      },
      video_short: {
        max_duration_seconds: 15,
        pros: 'Mas engaging, mejor para Reels, mas data points para Meta',
        cons: 'Mas costoso de producir, requiere buen hook',
        best_practices: [
          'Hook en los primeros 3 segundos — si no captura atencion, se pierde',
          'Subtitulos siempre (85% ve sin sonido)',
          'Formato vertical 9:16 para Reels y Stories',
          'Mostrar producto en uso real, no solo B-roll',
          'CTA claro al final'
        ]
      },
      ugc: {
        description: 'User Generated Content — contenido que parece hecho por un cliente real',
        pros: 'Mayor autenticidad, mejor engagement, menor costo de produccion',
        cons: 'Calidad variable, requiere gestionar creadores',
        best_practices: [
          'Formato testimonial: persona real hablando a camara',
          'Unboxing y first reactions',
          'Uso del producto en contexto real (BBQ, cena, picnic)',
          'NO debe parecer sobre-producido — la imperfeccion es la clave'
        ]
      }
    },
    fatigue_detection: {
      // 5-signal framework for creative fatigue detection
      five_signal_framework: [
        'Signal 1: CTR decline — 20%+ drop from 7-day peak indicates early fatigue',
        'Signal 2: CPM increase — 30%+ rise over 2 weeks means Meta is having trouble finding receptive audience',
        'Signal 3: Frequency acceleration — prospecting >2.5-3.0, retargeting >5-6 means audience recycling',
        'Signal 4: CPA creep — rising CPA with stable CTR means conversion resistance building',
        'Signal 5: Negative feedback — hide/report signals damage ad quality score permanently'
      ],
      signals: [
        'Frequency >2.5 con CTR bajando en los ultimos 7 dias',
        'CPM subiendo mientras CTR y conversion rate bajan',
        'El mismo creativo lleva >3 semanas activo sin refresh',
        'Engagement rate (reactions + comments + shares / impressions) cayendo',
        'Relevance diagnostics degradando (below average quality/engagement/conversion)'
      ],
      creative_lifespan: {
        typical_weeks: '2-4 semanas antes de fatiga visible',
        refresh_interval: '10-14 dias para mejores resultados',
        warning_signs_timeline: [
          'Dia 1-7: Rendimiento estable (learning + optimization)',
          'Dia 7-14: Peak performance (optimal delivery)',
          'Dia 14-21: Early fatigue (CTR empieza a bajar 5-10%)',
          'Dia 21-28: Moderate fatigue (CTR -20%, CPM +15%)',
          'Dia 28+: Severe fatigue (CTR -40%+, CPA subiendo, frequency alta)'
        ]
      },
      refresh_strategy: [
        'Rotar 2-3 creativos nuevos cada 2-3 semanas',
        'Mantener el formato que funciona pero cambiar el angulo de messaging',
        'Si un creativo tiene buen ROAS pero frequency alta, duplicar el ad set con nuevos creativos',
        'No apagar creativos ganadores — dejar que Meta reduzca su delivery naturalmente',
        'Testear variaciones incrementales del creativo ganador (nuevo headline, nuevo CTA, nuevo color)'
      ]
    },
    copy_best_practices: {
      headlines: [
        'Max 40 caracteres para evitar truncamiento en mobile',
        'Incluir el beneficio principal, no solo el feature',
        'Usar numeros cuando sea posible (20% off, 10,000+ sold)',
        'Probar pregunta vs afirmacion vs imperativo',
        'Personalizacion: "Your", "You" aumentan engagement'
      ],
      primary_text: [
        'Primera linea es la mas importante (visible antes del "See More")',
        'Contar una micro-historia o presentar un problema/solucion',
        'Social proof en el texto: "Join 10,000+ pickle lovers"',
        'Incluir emoji con moderacion (1-2 max) para romper monotonia visual',
        'CTA claro en el texto ademas del boton'
      ],
      cta_buttons: {
        shop_now: 'Mejor para ecommerce directo, alta intencion de compra',
        learn_more: 'Mejor para consideration, cuando el producto necesita explicacion',
        order_now: 'Urgencia, limited editions, pre-orders',
        get_offer: 'Cuando hay promocion activa',
        notes: 'SHOP_NOW tiene mejor conversion rate que LEARN_MORE para ecommerce directo'
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // SCALING METHODOLOGY
  // Como escalar sin perder eficiencia
  // ═══════════════════════════════════════════════════════════════
  scaling: {
    vertical: {
      description: 'Aumentar budget del mismo ad set',
      rules: [
        'Maximo 20% de aumento cada 2-3 dias',
        'Esperar que el gasto se estabilice antes del siguiente aumento',
        'Si ROAS cae >15% despues de un aumento, revertir',
        'No escalar ad sets que estan en learning phase',
        'Verificar ROAS consistente en 7d Y 14d antes de escalar'
      ],
      timeline: {
        '$100_to_300': 'Incrementos de 20% cada 3 dias — ~2 semanas',
        '$300_to_1000': 'Incrementos de 15-20% cada 3-4 dias — ~3-4 semanas',
        '$1000_to_3000': 'Incrementos de 10-15% cada 4-5 dias — ~4-6 semanas',
        note: 'Scaling es un maraton, no un sprint. La paciencia preserva ROAS.'
      }
    },
    horizontal: {
      description: 'Duplicar ad set con nuevos creativos o audiencias',
      when_to_use: [
        'Ad set ganador con ROAS >3x consistente en 14d',
        'Frequency acercandose a 2.5 en el ad set original',
        'Se quiere testear nuevos angulos de messaging sin afectar el ganador',
        'Budget del ad set actual es alto (>$300/dia) y no responde bien a aumentos'
      ],
      how_to: [
        'Duplicar el ad set manteniendo targeting similar',
        'Cambiar TODOS los creativos (nuevos angulos/formatos)',
        'Empezar con 50-70% del budget del original',
        'Dar 7 dias para salir de learning phase antes de evaluar',
        'Si ambos performan, mantener ambos y seguir diversificando'
      ]
    },
    prerequisites: [
      'ROAS consistente en 7d Y 14d (no solo 3d)',
      'Al menos 2 semanas de data estable',
      'Suficientes creativos frescos para alimentar el mayor spend',
      'Margen de CPA: no estar al limite del CPA maximo',
      'Sin senales de fatiga (frequency <2.0, CTR estable)'
    ],
    warning_signs: [
      'ROAS cae >20% despues de scaling — revertir y esperar',
      'CPA sube >30% — mercado saturado a ese budget level',
      'Frequency sube rapido despues de scaling — audiencia demasiado pequena',
      'Spending pattern erratico — Meta tiene dificultad optimizando'
    ]
  },

  // ═══════════════════════════════════════════════════════════════
  // AUDIENCE STRATEGY (Advantage+ era)
  // ═══════════════════════════════════════════════════════════════
  audience_strategy: {
    advantage_plus: {
      description: 'Sistema de targeting automatizado de Meta que usa ML para encontrar compradores',
      key_points: [
        'Con Advantage+ activo, Meta expande automaticamente mas alla del targeting definido',
        'La "audiencia sugerida" es solo un punto de partida — Meta va mas amplio',
        'Frequency alta con Advantage+ es MAS grave: significa que Meta ya agoto la audiencia accesible',
        'Advantage+ Shopping Campaigns eliminan targeting manual casi por completo'
      ],
      when_to_use_asc: [
        'Ecommerce con pixel maduro (1000+ purchase events en historial)',
        'Al menos 10 creativos disponibles (idealmente 15-20)',
        'Budget de $100+/dia',
        'Conversion API (CAPI) implementado'
      ]
    },
    broad_targeting: {
      description: 'Targeting con minimas restricciones (solo pais, edad basica)',
      rationale: [
        'Meta tiene mas datos que cualquier anunciante — dejar que su ML trabaje',
        'Audiencias estrechas limitan el delivery y suben CPM',
        'Broad targeting + buenos creativos = la combinacion ganadora actual',
        'El creativo actua como el "targeting" — atrae a la audiencia correcta'
      ],
      exceptions: [
        'Retargeting necesita audiencia especifica (website visitors, cart abandoners)',
        'Productos con audiencia muy nicho pueden necesitar interest targeting',
        'Geo-targeting es valido para negocios locales'
      ]
    },
    retargeting: {
      when_worth_it: [
        'Sitio con >100K visitantes mensuales',
        'Cart abandonment rate alto (>70%)',
        'Producto de alto valor (AOV >$50) donde el consideration period es largo'
      ],
      best_practices: [
        'Separar por ventana temporal: 1-3 dias, 4-7 dias, 8-14 dias',
        'Cart abandoners merecen ad set separado con messaging especifico',
        'No competir con prospecting por la misma audiencia',
        'Budget de retargeting: 10-20% del total, no mas'
      ]
    },
    lookalike_audiences: {
      current_status: 'Advantage+ audiences han reemplazado LAL en muchos casos',
      still_useful_when: [
        'Como "audiencia sugerida" dentro de Advantage+ campaigns',
        'Para cuentas que estan empezando sin historial de pixel',
        'Best source: compradores de alto valor (top 1-5% por LTV)'
      ]
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // BENCHMARKS & THRESHOLDS
  // Metricas de referencia para ecommerce/food vertical
  // ═══════════════════════════════════════════════════════════════
  benchmarks: {
    food_ecommerce_2025: {
      cpm_range: { low: 8, median: 13.48, high: 25, unit: 'USD' },
      ctr_range: { low: 0.8, median: 1.85, high: 2.5, unit: '%' },
      cpa_range: { low: 15, median: 38.17, high: 50, unit: 'USD' },
      roas_range: { low: 1.5, median: 2.87, high: 6.0, unit: 'x' },
      frequency_healthy: { max: 2.0, warning: 2.5, critical: 4.0 },
      conversion_rate: { low: 1.5, median: 2.02, high: 5.0, unit: '%' },
      aov_range: { low: 40, median: 61.71, high: 90, unit: 'USD' },
      notes: [
        'CPM varies heavily by season — Q4 can be 2-3x Q1',
        'Food/beverage typically has lower CPA than fashion/electronics',
        'DTC food brands average ROAS of 2.5-4.0x',
        'All-industry median ROAS dropped to 1.93 in 2025 (was higher in 2024)',
        'Food & Beverage CTR of 1.85% is lowest among verticals',
        'Food AOV grew +8.4% YoY to $61.71 in 2025',
        'CPC in food increased +69.44% YoY — highest increase across verticals',
        'CPM trending +20% YoY across industries — competition increasing'
      ]
    },
    seasonal_cpm_multipliers: {
      q1: 0.85,
      q2: 1.0,
      q3: 1.05,
      q4_early: 1.3,
      q4_bfcm: 2.0,
      q4_holiday: 1.5,
      note: 'CPM se multiplica por estos factores en cada trimestre vs baseline'
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // AUDIENCE SATURATION DETECTION
  // Señales de que la audiencia está agotada
  // ═══════════════════════════════════════════════════════════════
  audience_saturation: {
    detection_signals: [
      'First Time Impression Ratio declining (available in Delivery Insights)',
      'Audience Reached Ratio approaching 100% (available in Delivery Insights)',
      'Frequency >3-4 in 7-day window',
      'CTR declining while frequency increases (classic divergence)',
      'Reach growth stagnating despite maintained/increased spend',
      'Diminishing returns: spend increasing but conversions flat or declining'
    ],
    overlap_threshold: {
      warning: 0.25,
      critical: 0.30,
      impact: 'Audience overlap >25% means ad sets are bidding against each other, inflating CPM'
    },
    scaling_strategy: {
      hybrid: 'Vertical scaling until CPA rises, then switch to horizontal',
      vertical_limit: 'When CPA rises >15% after budget increase, audience is saturating',
      horizontal_trigger: 'Create new ad set with different creative angles for fresh audience pool',
      audience_rest: 'If severely saturated, reduce budget 50% for 3-5 days to let audience "reset"'
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // FUNNEL DIAGNOSIS FRAMEWORK
  // How to diagnose WHERE conversion problems happen
  // ═══════════════════════════════════════════════════════════════
  funnel_diagnosis: {
    stages: {
      impression_to_click: {
        metric: 'CTR',
        healthy: '>1.0%',
        problem: '<0.5%',
        diagnosis_if_low: 'Creative not capturing attention — weak hook, wrong format, or targeting mismatch',
        action: 'Refresh creatives, test new hooks, try different formats (video, carousel, UGC)'
      },
      click_to_atc: {
        metric: 'ATC/Clicks',
        healthy: '>5%',
        problem: '<2%',
        diagnosis_if_low: 'Landing page disconnect — ad promise doesnt match page, slow load, poor mobile UX, price shock',
        action: 'DO NOT pause ad or ad set — fix landing page. Check page speed, mobile experience, pricing visibility'
      },
      atc_to_ic: {
        metric: 'IC/ATC',
        healthy: '>50%',
        problem: '<25%',
        diagnosis_if_low: 'Checkout friction — shipping cost surprise, long forms, lack of trust signals, no guest checkout',
        action: 'Audit checkout flow. Show shipping costs early. Add trust badges. Simplify forms.'
      },
      ic_to_purchase: {
        metric: 'Purchase/IC',
        healthy: '>60%',
        problem: '<30%',
        diagnosis_if_low: 'Payment/final step issue — payment errors, extra costs at final step, technical bugs',
        action: 'Check payment processing. Look for error rates. Ensure no surprise fees at final step.'
      }
    },
    critical_pattern: {
      high_ctr_zero_conversions: {
        description: 'CTR >1% but 0 purchases with 50+ clicks',
        root_cause: '#1 culprit is landing page mismatch — the ad attracts clicks but the page fails to convert',
        common_reasons: [
          'Wrong campaign objective (Traffic instead of Conversions)',
          'Audience too broad — attracting clicks from non-buyers',
          'Broken pixel or CAPI — conversions happening but not tracked',
          'Funnel stage misalignment — ad shows product but lands on homepage',
          'Trust/friction issues — no reviews, no SSL, unclear returns policy'
        ],
        action: 'NEVER pause the ad set for this pattern. Investigate landing page first. Check pixel fires. Verify campaign objective.'
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // DIAGNOSTIC FRAMEWORK
  // Como diagnosticar problemas comunes y que hacer
  // ═══════════════════════════════════════════════════════════════
  diagnostics: {
    high_cpm_low_ctr: {
      likely_causes: [
        'Creativos no capturan atencion — falta scroll-stopping hook',
        'Audiencia saturada — frequency demasiado alta',
        'Ad quality score bajo por negative feedback'
      ],
      solutions: [
        'Nuevos creativos con hook mas fuerte en los primeros 3 segundos',
        'Rotar angulos de messaging — probar UGC si solo se usan estaticos',
        'Ampliar audiencia si frequency es alta',
        'Revisar ad quality diagnostics en Ads Manager'
      ]
    },
    good_ctr_low_conversion: {
      likely_causes: [
        'Landing page no convierte — slow, confusing, or poor UX',
        'Disconnect entre el ad y la landing page',
        'Precio del producto no match las expectativas del ad',
        'Checkout friction (shipping cost surprise, long forms)',
        'Wrong optimization event (traffic instead of purchase)'
      ],
      solutions: [
        'Auditar landing page: load time, mobile UX, checkout flow',
        'Asegurar consistencia entre ad y landing page',
        'Considerar optimizar para purchase si se esta usando add_to_cart',
        'Implementar CAPI para mejor tracking de conversiones',
        'A/B test landing pages'
      ]
    },
    roas_declining: {
      likely_causes: [
        'Creative fatigue — mismos ads por mucho tiempo',
        'Audience saturation — audiencia limitada ya fue impactada',
        'Seasonal CPM increase consuming more budget',
        'Competencia incrementada en la vertical',
        'Attribution window changes o tracking issues'
      ],
      solutions: [
        'Refresh creativos inmediatamente (nuevos angulos, formatos)',
        'Expandir targeting o probar nuevas audiencias',
        'Revisar si tracking esta funcionando (CAPI, pixel events)',
        'Evaluar si el decline es real o es attribution lag',
        'Comparar metricas de 7d vs 14d para confirmar tendencia'
      ]
    },
    underspending: {
      likely_causes: [
        'Bid demasiado bajo (con cost cap o bid cap)',
        'Audiencia demasiado estrecha',
        'Ad quality muy bajo — Meta no quiere mostrar el ad',
        'Demasiados ad sets compitiendo entre si (auction overlap)',
        'Learning phase con datos insuficientes'
      ],
      solutions: [
        'Si usa cost cap, aumentar el cap o cambiar a lowest cost',
        'Ampliar audiencia',
        'Nuevos creativos con mejor quality score',
        'Consolidar ad sets para reducir internal competition',
        'Verificar que no hay audience overlap alto'
      ]
    },
    high_frequency_low_roas: {
      likely_causes: [
        'Audiencia agotada — todos los prospects viables ya vieron el ad',
        'Creative fatigue severa',
        'Retargeting pool demasiado pequeno',
        'Budget demasiado alto para el tamano de la audiencia'
      ],
      solutions: [
        'URGENTE: Refrescar creativos con angulos completamente nuevos',
        'Ampliar audiencia significativamente',
        'Si es retargeting, reducir budget y frequency cap',
        'Considerar pausa temporal para que la audiencia "descanse"',
        'Horizontal scaling: nuevo ad set con audiencia fresca'
      ]
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // TESTING FRAMEWORK
  // Como estructurar A/B tests y experimentos
  // ═══════════════════════════════════════════════════════════════
  testing: {
    principles: [
      'Testear UNA variable a la vez para resultados claros',
      'Necesitas volumen estadisticamente significativo: minimo 100 conversiones por variante',
      'Minimum test duration: 7 dias (para cubrir learning phase)',
      'No cambiar el test antes de que termine — comprometer data',
      'Definir metrica de exito ANTES de empezar (ROAS, CPA, CTR)'
    ],
    what_to_test: {
      high_impact: [
        'Creative format (imagen vs video vs carrusel vs UGC)',
        'Messaging angle (beneficio vs social proof vs urgencia)',
        'Offer type (descuento % vs envio gratis vs bundle)',
        'Optimization event (purchase vs add_to_cart)'
      ],
      medium_impact: [
        'Headline variaciones',
        'CTA button type',
        'Primary text length (short vs long)',
        'Image composition (product vs lifestyle)'
      ],
      low_impact: [
        'Small color changes',
        'Minor copy tweaks',
        'Description text (most users dont see it)',
        'Display link text'
      ]
    },
    meta_experiments: {
      a_b_test: 'Usar el feature nativo de A/B test de Ads Manager para split testing',
      dynamic_creative: {
        description: 'Meta combina automaticamente variantes de imagen, headline, text, CTA',
        pros: 'Rapido, descubre combinaciones ganadoras automaticamente',
        cons: 'Dificil aislar que variable hace la diferencia',
        best_for: 'Encontrar combinaciones ganadoras rapidamente antes de escalar'
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // PLATFORM CHANGES & TRENDS (updated regularly)
  // Cambios recientes en Meta que impactan estrategia
  // ═══════════════════════════════════════════════════════════════
  platform_trends_2026: {
    key_changes: [
      'Advantage+ campaigns siguen expandiendose — Meta empuja automatizacion total',
      'AI creative tools (text generation, image expansion) integrados nativamente',
      'Reels placement se ha vuelto uno de los de mejor rendimiento para ecommerce',
      'Conversion API (CAPI) es practicamente obligatorio para tracking preciso',
      'Shops Ads: anuncios que venden directamente dentro de Facebook/Instagram sin salir',
      'Advantage+ Creative ajusta automaticamente aspectos visuales del ad para cada persona',
      'Unified attribution settings mid-2025 — standardized measurement across campaigns',
      'Andromeda retrieval engine (2025) — Metas new ad delivery system with 87% prediction accuracy',
      'Oct 2025: 7d/28d view-through attribution deprecated — move to click-based attribution',
      'Jan 2026: 28-day attribution windows fully deprecated',
      'Advantage+ Sales Campaigns (ASC): 22% higher revenue per dollar, max 150 ads (50/ad set)',
      'ASC best practice: start with 10-20 creatives, scale after 50+ conversions, hybrid approach with manual campaigns'
    ],
    recommendations: [
      'Implementar CAPI si no esta activo — critico para measurement accuracy',
      'Crear contenido vertical 9:16 para Reels — es el placement con mayor crecimiento',
      'Probar Advantage+ Shopping Campaigns si hay suficiente volumen de creativos',
      'Usar Advantage+ Creative optimizations para personalizar automaticamente',
      'Considerar video corto (<15s) como formato prioritario',
      'Migrate to click-based attribution before Oct 2025 deprecation',
      'View-through attribution can inflate ROAS 15-30% — track click-through separately for true performance'
    ],
    meta_algorithm_insights: {
      total_value_formula: 'Advertiser Bid x Estimated Action Rate x Ad Quality Score',
      prediction_accuracy: '87% for purchase prediction (Q4 2025)',
      explore_exploit: 'Learning phase = explore (high variance), Post-learning = exploit (optimized delivery)',
      real_time_adjustments: 'Meta adjusts bids, audience targeting, and placements in real-time based on signals',
      implications: [
        'Higher ad quality score can win auctions with lower bids — focus on creative quality',
        'Stable conversion history improves Estimated Action Rate — avoid disrupting winning ad sets',
        'Frequent edits reset predictions — batch changes and minimize disruptions',
        'Algorithm needs 50+ data points to optimize well — ensure sufficient budget for conversion volume'
      ]
    }
  }
};
