import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalNetworkBanner } from './LocalNetworkBanner';

describe('LocalNetworkBanner', () => {
  it('renders local network warning copy', () => {
    const html = renderToStaticMarkup(<LocalNetworkBanner />);
    expect(html).toContain('role="note"');
    expect(html).toContain("Local Network Only");
    expect(html).toContain("trusted LAN access only");
  });
});
