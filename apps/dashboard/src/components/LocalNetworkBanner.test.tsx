import { render, screen } from '@testing-library/react';
import { LocalNetworkBanner } from './LocalNetworkBanner';

describe('LocalNetworkBanner', () => {
  it('renders local network warning copy', () => {
    render(<LocalNetworkBanner />);

    expect(screen.getByRole('note', { name: /local network only/i })).toBeInTheDocument();
    expect(screen.getByText(/trusted lan access only/i)).toBeInTheDocument();
  });
});
