import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOKF, composeEmbeddingText } from './okf.mjs';
import { OKF_DOCS } from './okf-corpus.mjs';

const SAMPLE = `---
type: Nota técnica
title: Prueba de parser
description: Una descripcion de prueba.
tags: [alfa, beta]
---

# Resumen

Cuerpo de prueba.`;

test('parseOKF extrae frontmatter y body', () => {
  const c = parseOKF(SAMPLE);
  assert.equal(c.type, 'Nota técnica');
  assert.equal(c.title, 'Prueba de parser');
  assert.equal(c.description, 'Una descripcion de prueba.');
  assert.deepEqual(c.tags, ['alfa', 'beta']);
  assert.ok(c.body.includes('# Resumen'));
  assert.ok(c.body.includes('Cuerpo de prueba.'));
});

test('parseOKF sin tags devuelve array vacio', () => {
  const c = parseOKF(`---\ntype: X\ntitle: T\ndescription: D\n---\nbody`);
  assert.deepEqual(c.tags, []);
});

test('composeEmbeddingText formato exacto con tags', () => {
  const s = composeEmbeddingText({ title: 'T', description: 'D.', tags: ['a', 'b'] });
  assert.equal(s, 'T. D. [tags: a, b]');
});

test('composeEmbeddingText omite tags vacios', () => {
  const s = composeEmbeddingText({ title: 'T', description: 'D.', tags: [] });
  assert.equal(s, 'T. D.');
});

test('corpus: 10 docs, ids correctos, todos parsean con campos completos', () => {
  const expectedIds = ['ia-salud','ml-finanzas','nlp-chatbots','cv-autonomos','db-vectoriales','cloud-infra','robotica','rec-systems','gen-ai','etica-ia'];
  assert.equal(OKF_DOCS.length, 10);
  assert.deepEqual(OKF_DOCS.map(d => d.id), expectedIds);
  for (const d of OKF_DOCS) {
    const c = parseOKF(d.md);
    assert.equal(c.type, 'Nota técnica');
    assert.ok(c.title.length >= 3, d.id + ' title');
    assert.ok(c.description.length > 10, d.id + ' description');
    assert.ok(c.tags.length >= 2 && c.tags.length <= 4, d.id + ' tags');
    assert.ok(c.body.includes('# Resumen'), d.id + ' body');
    const emb = composeEmbeddingText(c);
    assert.ok(emb.startsWith(c.title + '. '), d.id + ' embed text');
    assert.ok(emb.includes(c.description), d.id + ' embed text incluye description');
  }
});

test('descriptions del corpus = textos originales exactos', () => {
  const originals = {
    'ia-salud': 'La inteligencia artificial esta revolucionando el diagnostico medico',
    'ml-finanzas': 'Machine learning aplicado a la deteccion de fraudes financieros',
    'nlp-chatbots': 'Procesamiento de lenguaje natural para chatbots empresariales',
    'cv-autonomos': 'Vision por computadora en vehiculos autonomos',
    'db-vectoriales': 'Bases de datos vectoriales para busqueda semantica',
    'cloud-infra': 'Infraestructura cloud para despliegue de modelos de IA',
    'robotica': 'Robotica industrial y automatizacion con deep learning',
    'rec-systems': 'Sistemas de recomendacion basados en embeddings',
    'gen-ai': 'Modelos generativos de texto e imagenes con transformers',
    'etica-ia': 'Etica y sesgo en sistemas de inteligencia artificial',
  };
  for (const d of OKF_DOCS) {
    assert.equal(parseOKF(d.md).description, originals[d.id], d.id);
  }
});