import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeywordSettings } from '../keyword-settings';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';

// Mock SettingsSection to just render children
vi.mock('../settings-section', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('KeywordSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS] });
  });

  it('renders all default keywords', () => {
    render(<KeywordSettings />);
    DEFAULT_KEYWORDS.forEach((kw) => {
      expect(screen.getByText(kw.label)).toBeInTheDocument();
    });
  });

  it('shows keyword JMAP id', () => {
    render(<KeywordSettings />);
    expect(screen.getByText('$label:red')).toBeInTheDocument();
    expect(screen.getByText('$label:blue')).toBeInTheDocument();
  });

  it('renders add keyword button', () => {
    render(<KeywordSettings />);
    expect(screen.getByText('add_keyword')).toBeInTheDocument();
  });

  it('renders reset defaults button', () => {
    render(<KeywordSettings />);
    expect(screen.getByText('reset_defaults')).toBeInTheDocument();
  });

  it('shows add form when add button clicked', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));
    expect(screen.getByPlaceholderText('label_placeholder')).toBeInTheDocument();
    // Cancel and save buttons should appear
    expect(screen.getByText('cancel')).toBeInTheDocument();
    expect(screen.getByText('add')).toBeInTheDocument();
  });

  it('adds a new keyword through the form', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    const input = screen.getByPlaceholderText('label_placeholder');
    fireEvent.change(input, { target: { value: 'Important' } });
    fireEvent.click(screen.getByText('add'));

    const keywords = useSettingsStore.getState().emailKeywords;
    expect(keywords).toHaveLength(DEFAULT_KEYWORDS.length + 1);
    expect(keywords[keywords.length - 1].label).toBe('Important');
    expect(keywords[keywords.length - 1].id).toBe('important');
  });

  it('prevents adding keyword with duplicate id', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    const input = screen.getByPlaceholderText('label_placeholder');
    fireEvent.change(input, { target: { value: 'Red' } });

    // Should show duplicate warning
    expect(screen.getByText('id_exists')).toBeInTheDocument();
  });

  it('cancels add form when cancel clicked', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));
    expect(screen.getByPlaceholderText('label_placeholder')).toBeInTheDocument();

    fireEvent.click(screen.getByText('cancel'));
    expect(screen.queryByPlaceholderText('label_placeholder')).not.toBeInTheDocument();
  });

  it('deletes keyword when delete button clicked', () => {
    render(<KeywordSettings />);
    // Find delete buttons (title="delete")
    const deleteButtons = screen.getAllByTitle('delete');
    expect(deleteButtons.length).toBe(DEFAULT_KEYWORDS.length);

    // Delete the first keyword
    fireEvent.click(deleteButtons[0]);
    expect(useSettingsStore.getState().emailKeywords).toHaveLength(DEFAULT_KEYWORDS.length - 1);
    expect(useSettingsStore.getState().emailKeywords.find((k) => k.id === 'red')).toBeUndefined();
  });

  it('shows edit form when edit button clicked', () => {
    render(<KeywordSettings />);
    const editButtons = screen.getAllByTitle('edit');
    fireEvent.click(editButtons[0]); // edit first keyword (Red)

    const input = screen.getByDisplayValue('Red');
    expect(input).toBeInTheDocument();
    expect(screen.getByText('save')).toBeInTheDocument();
  });

  it('updates keyword label through edit form', () => {
    render(<KeywordSettings />);
    const editButtons = screen.getAllByTitle('edit');
    fireEvent.click(editButtons[0]); // edit "Red"

    const input = screen.getByDisplayValue('Red');
    fireEvent.change(input, { target: { value: 'Crimson' } });
    fireEvent.click(screen.getByText('save'));

    const kw = useSettingsStore.getState().emailKeywords.find((k) => k.id === 'red');
    expect(kw?.label).toBe('Crimson');
  });

  it('resets to defaults when reset button clicked', () => {
    // Modify keywords first
    useSettingsStore.getState().removeKeyword('red');
    useSettingsStore.getState().removeKeyword('blue');
    expect(useSettingsStore.getState().emailKeywords).toHaveLength(DEFAULT_KEYWORDS.length - 2);

    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('reset_defaults'));

    expect(useSettingsStore.getState().emailKeywords).toEqual(DEFAULT_KEYWORDS);
  });

  it('normalizes label to id correctly', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByText('add_keyword'));

    const input = screen.getByPlaceholderText('label_placeholder');
    fireEvent.change(input, { target: { value: 'My Custom Tag!' } });
    fireEvent.click(screen.getByText('add'));

    const keywords = useSettingsStore.getState().emailKeywords;
    const added = keywords[keywords.length - 1];
    expect(added.id).toBe('my-custom-tag');
    expect(added.label).toBe('My Custom Tag!');
  });
});
