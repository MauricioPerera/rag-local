// okf-corpus.mjs — corpus de 10 documentos OKF.
// description = texto original EXACTO del POC RAG.

function doc(id, title, description, tags, resumen) {
  const md = `---
type: Nota técnica
title: ${title}
description: ${description}
tags: [${tags.join(', ')}]
---

# Resumen

${resumen}`;
  return { id, md };
}

export const OKF_DOCS = [
  doc(
    'ia-salud',
    'Inteligencia Artificial en Salud',
    'La inteligencia artificial esta revolucionando el diagnostico medico',
    ['ia', 'diagnostico medico', 'salud'],
    'La IA aplicada al diagnostico medico permite detectar enfermedades de forma temprana y mas precisa, apoyando al profesional de la salud.'
  ),
  doc(
    'ml-finanzas',
    'Machine Learning contra Fraudes',
    'Machine learning aplicado a la deteccion de fraudes financieros',
    ['machine learning', 'fraude', 'finanzas'],
    'Modelos de machine learning analizan patrones de transacciones para marcar operaciones sospechosas y reducir perdidas por fraude.'
  ),
  doc(
    'nlp-chatbots',
    'NLP para Chatbots Empresariales',
    'Procesamiento de lenguaje natural para chatbots empresariales',
    ['nlp', 'chatbots', 'procesamiento de lenguaje'],
    'El procesamiento de lenguaje natural habilita chatbots que entienden consultas de clientes y responden de forma automatica en contextos empresariales.'
  ),
  doc(
    'cv-autonomos',
    'Vision Artificial en Autonomos',
    'Vision por computadora en vehiculos autonomos',
    ['vision por computadora', 'vehiculos autonomos', 'computo visual'],
    'La vision por computadora permite a los vehiculos autonomos percibir el entorno, detectar obstaculos y tomar decisiones de conduccion.'
  ),
  doc(
    'db-vectoriales',
    'Bases de Datos Vectoriales',
    'Bases de datos vectoriales para busqueda semantica',
    ['bases de datos vectoriales', 'busqueda semantica', 'embeddings'],
    'Las bases de datos vectoriales almacenan embeddings y permiten recuperar documentos por similitud semantica, base del RAG.'
  ),
  doc(
    'cloud-infra',
    'Infraestructura Cloud para IA',
    'Infraestructura cloud para despliegue de modelos de IA',
    ['cloud', 'infraestructura', 'despliegue de modelos'],
    'La infraestructura cloud escala GPU y almacenamiento para desplegar y servir modelos de IA en produccion de forma elastica.'
  ),
  doc(
    'robotica',
    'Robotica Industrial con Deep Learning',
    'Robotica industrial y automatizacion con deep learning',
    ['robotica', 'automatizacion', 'deep learning'],
    'El deep learning mejora la robotica industrial dotando a los brazos mecanicos de percepcion y adaptacion para tareas de automatizacion.'
  ),
  doc(
    'rec-systems',
    'Sistemas de Recomendacion por Embeddings',
    'Sistemas de recomendacion basados en embeddings',
    ['sistemas de recomendacion', 'embeddings', 'recomendacion'],
    'Los sistemas de recomendacion basados en embeddings representan usuarios e items en un mismo espacio vectorial para sugerir contenido relevante.'
  ),
  doc(
    'gen-ai',
    'Modelos Generativos con Transformers',
    'Modelos generativos de texto e imagenes con transformers',
    ['modelos generativos', 'transformers', 'texto e imagenes'],
    'Los modelos generativos basados en transformers producen texto e imagenes nuevos aprendiendo distribuciones a partir de grandes corpus.'
  ),
  doc(
    'etica-ia',
    'Etica y Sesgo en IA',
    'Etica y sesgo en sistemas de inteligencia artificial',
    ['etica', 'sesgo', 'inteligencia artificial'],
    'La etica en IA busca mitigar sesgos y garantizar decisiones justas, transparentes y responsables en los sistemas de inteligencia artificial.'
  ),
];