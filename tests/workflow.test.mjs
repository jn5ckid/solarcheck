import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const stages = ['lookup', 'facade', 'solar', 'generation', 'report'];

test('five workflow stages and top navigation are present in order', () => {
  let lastSection = -1;
  let lastNav = -1;
  for (const stage of stages) {
    const section = html.indexOf(`id="step-${stage}"`);
    const nav = html.indexOf(`data-stage="${stage}"`);
    assert.ok(section > lastSection, `${stage} section should follow the previous stage`);
    assert.ok(nav > lastNav, `${stage} navigation should follow the previous stage`);
    lastSection = section;
    lastNav = nav;
  }
});

test('stage progression controls and unlock order are wired', () => {
  for (const id of ['lookup-next', 'facade-next', 'solar-next', 'generation-next']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(app, new RegExp(`\\$\\('#${id}'\\)\\.addEventListener`));
  }
  assert.match(app, /const STAGES = \['lookup', 'facade', 'solar', 'generation', 'report'\]/);
});

test('direct DOM references resolve to unique elements', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML ids must be unique');
  const directReferences = [...app.matchAll(/\$\('#([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(directReferences.filter(id => !ids.includes(id)))], []);
});
