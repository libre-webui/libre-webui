# Keyboard Shortcuts Implementation

## Overview
This implementation adds VS Code-like keyboard shortcuts to the Libre WebUI application, making it more efficient for power users.

## Implemented Shortcuts

### Navigation
- **⌘B** (Cmd+B on Mac, Ctrl+B on Windows/Linux): Toggle sidebar visibility
- **⌘D** (Cmd+D): Toggle dark/light theme

### Settings & Help
- **⌘,** (Cmd+Comma): Open settings modal
- **?**: Show keyboard shortcuts help modal
- **Esc**: Close open modals

### Chat (existing)
- **Enter**: Send message
- **Shift+Enter**: New line in message

## Files Modified/Created

### New Files
1. **`frontend/src/hooks/useKeyboardShortcuts.ts`**
   - Custom hook for managing keyboard shortcuts
   - Handles key combination detection and prevents conflicts with input fields
   - Provides helper functions for formatting shortcut displays

2. **`frontend/src/components/KeyboardShortcuts.tsx`**
   - Modal component displaying all available keyboard shortcuts
   - Floating indicator button for easy access
   - Organized shortcuts by category (Navigation, Settings, Chat)

### Modified Files
1. **`frontend/src/App.tsx`**
   - Integrated keyboard shortcuts system
   - Added state management for modals (settings, shortcuts)
   - Implemented global keyboard shortcut handlers

2. **`frontend/src/components/Header.tsx`**
   - Updated to accept `onSettingsClick` prop
   - Removed internal settings modal management
   - Added keyboard shortcut hints to tooltips

3. **`frontend/src/components/Sidebar.tsx`**
   - Added keyboard shortcut hints in footer
   - Shows ⌘B shortcut for sidebar toggle
   - Shows ? shortcut for help

4. **`frontend/src/components/ThemeToggle.tsx`**
   - Added ⌘D shortcut hint to tooltip

5. **`frontend/src/components/SidebarToggle.tsx`**
   - Added ⌘B shortcut hint to tooltip

6. **`frontend/src/components/index.ts`**
   - Exported new keyboard shortcuts components

## Features

### Smart Conflict Prevention
- Shortcuts are disabled when user is typing in input fields, textareas, or contenteditable elements
- Prevents accidental triggering while composing messages

### Cross-Platform Compatibility
- Uses metaKey detection for Cmd on Mac and Ctrl on Windows/Linux
- Displays appropriate symbols (⌘ vs Ctrl) based on platform

### Visual Indicators
- Tooltips show keyboard shortcuts for relevant buttons
- Floating help button in bottom-right corner
- Footer hints in sidebar
- kbd elements for proper shortcut styling

### Modal Management
- Centralized modal state management in App component
- Esc key closes all modals
- Proper z-index stacking

## Usage

### For Users
1. Press **⌘B** to quickly toggle the sidebar
2. Press **⌘,** to open settings
3. Press **⌘D** to switch themes
4. Press **?** to see all available shortcuts
5. Look for keyboard shortcut hints in tooltips and the sidebar footer

### For Developers
1. Import and use `useKeyboardShortcuts` hook for custom shortcuts
2. Add new shortcuts to the `shortcuts` array in App.tsx
3. Use `formatShortcut` helper to display shortcuts consistently
4. Follow the pattern for adding tooltips with shortcut hints

## Implementation Notes

- Keyboard shortcuts use the same state management as existing UI controls
- No new dependencies were added - uses existing React patterns
- Fully integrated with the existing theme system
- Responsive design works on all screen sizes
- Accessible with proper ARIA labels and semantic HTML

## Testing
- All shortcuts work as expected in the browser
- No conflicts with existing functionality
- Proper fallbacks when shortcuts are disabled
- Visual feedback through tooltips and help modal

This implementation provides a VS Code-like experience while maintaining the app's existing design language and functionality.
