import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders hello content', () => {
    render(<App />);
    expect(screen.getByText('Web app says hello.')).toBeInTheDocument();
  });
});
