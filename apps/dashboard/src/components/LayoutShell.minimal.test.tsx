import { describe, expect, test } from 'bun:test';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';

import { LayoutShell } from './LayoutShell';

describe('LayoutShell minimal nav', () => {
  test('shows only Chat, Focus, History in navigation', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path='/' element={<LayoutShell />}>
            <Route path='chat' element={<div>chat</div>} />
            <Route path='focus' element={<div>focus</div>} />
            <Route path='history' element={<div>history</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(html).toContain('>Chat<');
    expect(html).toContain('>Focus<');
    expect(html).toContain('>History<');
    expect(html).not.toContain('>Runs<');
    expect(html).not.toContain('>Queue<');
  });
});
