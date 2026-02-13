import { describe, expect, it } from 'bun:test';
import { appIcons } from './icons';

describe('appIcons', () => {
  it('exposes canonical icon mappings for core navigation and actions', () => {
    expect(appIcons.chat).toBeDefined();
    expect(appIcons.focus).toBeDefined();
    expect(appIcons.history).toBeDefined();
    expect(appIcons.send).toBeDefined();
    expect(appIcons.compact).toBeDefined();
    expect(appIcons.failed).toBeDefined();
    expect(appIcons.blocked).toBeDefined();
  });
});

