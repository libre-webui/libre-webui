/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input } from './Input';
import { Textarea } from './Textarea';
import { Select } from './Select';

const fields = [
  {
    name: 'input',
    render: (props: Parameters<typeof Input>[0]) => <Input {...props} />,
  },
  {
    name: 'textarea',
    render: (props: Parameters<typeof Textarea>[0]) => <Textarea {...props} />,
  },
  {
    name: 'select',
    render: (props: Omit<Parameters<typeof Select>[0], 'options'>) => (
      <Select {...props} options={[]} />
    ),
  },
];

for (const field of fields) {
  test(`${field.name} links validation errors and preserves caller descriptions`, () => {
    const html = renderToStaticMarkup(
      field.render({
        id: 'field',
        label: 'Title',
        error: 'A title is required',
        helper: 'Hidden helper',
        'aria-describedby': 'context',
        'aria-invalid': false,
      })
    );
    assert.match(html, /aria-invalid="true"/);
    assert.match(html, /aria-describedby="context field-feedback"/);
    assert.match(html, /id="field-feedback" role="alert"/);
    assert.match(html, /A title is required/);
    assert.doesNotMatch(html, /Hidden helper/);
  });

  test(`${field.name} describes helper text without announcing an error`, () => {
    const html = renderToStaticMarkup(
      field.render({ id: 'field', helper: 'Useful context' })
    );
    assert.match(html, /aria-describedby="field-feedback"/);
    assert.match(html, /id="field-feedback"/);
    assert.doesNotMatch(html, /aria-invalid|role="alert"/);
    const plain = renderToStaticMarkup(
      field.render({ 'aria-describedby': 'context', 'aria-invalid': 'grammar' })
    );
    assert.match(plain, /aria-describedby="context"/);
    assert.match(plain, /aria-invalid="grammar"/);
    assert.doesNotMatch(plain, /-feedback/);
  });
}
