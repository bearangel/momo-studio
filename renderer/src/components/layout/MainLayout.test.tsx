// renderer/src/components/layout/MainLayout.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainLayout } from './MainLayout';
import { useUiStore } from '../../stores/ui.store';

describe('MainLayout', () => {
  beforeEach(() => {
    // Reset store state between tests so view is deterministic.
    useUiStore.setState({ activeView: 'im' });
  });

  it('renders left rail with all 5 nav icons', () => {
    render(<MainLayout />);
    expect(screen.getByLabelText('View: IM')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Files')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Agents')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Marketplace')).toBeInTheDocument();
    expect(screen.getByLabelText('View: Settings')).toBeInTheDocument();
  });

  it('clicking nav icon switches active view', () => {
    render(<MainLayout />);
    fireEvent.click(screen.getByLabelText('View: Settings'));
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('middle panel shows "coming soon" placeholder for IM view in M0', () => {
    render(<MainLayout />);
    expect(screen.getByText(/coming soon|not yet/i)).toBeInTheDocument();
  });
});
