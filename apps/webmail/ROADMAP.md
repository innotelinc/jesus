# JMAP Webmail - Roadmap

This document tracks the development status and planned features for JMAP Webmail.

## Completed Features

### Core Infrastructure
- [x] Next.js 16 with TypeScript and App Router
- [x] Tailwind CSS v4 with Oxide engine
- [x] Zustand state management
- [x] JMAP client implementation (jmap-jam)

### Authentication
- [x] Login with JMAP server authentication
- [x] Session management (no password storage for security)
- [x] Username autocomplete with history
- [x] Logout functionality
- [x] Authentication error handling
- [x] JMAP identities for sender address

### JMAP Server Connection
- [x] Session establishment and keep-alive
- [x] Connection error handling and retries
- [x] Storage quota display
- [x] Server capability detection
- [x] Shared folders support (multi-account access)

### Email Operations
- [x] Email fetching and display
- [x] Full HTML email rendering
- [x] Compose, reply, reply-all, forward
- [x] Draft auto-save with discard confirmation
- [x] Mark as read/unread
- [x] Star/unstar emails
- [x] Delete and archive
- [x] Color tags/labels
- [x] Full-text search
- [x] Attachment upload and download
- [x] Batch operations (multi-select)
- [x] Quick reply form
- [x] Email threading (Gmail-style inline expansion)

### Real-time Updates
- [x] EventSource for JMAP push notifications
- [x] State synchronization
- [x] Email arrival notifications
- [x] Real-time unread counts
- [x] Mailbox change handling

### User Interface
- [x] Three-pane layout (sidebar, list, viewer)
- [x] Minimalist design system
- [x] Dark and light theme support
- [x] Custom scrollbars
- [x] Mobile responsive design
- [x] Keyboard shortcuts
- [x] Drag-and-drop email organization
- [x] Right-click context menus
- [x] Hierarchical mailbox display
- [x] Email list with avatars and visual hierarchy
- [x] Expandable email headers
- [x] External content warning banner
- [x] SPF/DKIM/DMARC status indicators
- [x] Loading states and skeletons
- [x] Smooth transitions and animations
- [x] Infinite scroll pagination
- [x] Error boundaries
- [x] Settings page with preferences

### Internationalization
- [x] English language support
- [x] French language support
- [x] Japanese language support
- [x] Spanish language support
- [x] Italian language support
- [x] German language support
- [x] Dutch language support
- [x] Portuguese language support
- [x] Automatic browser language detection
- [x] Language preference persistence

### Security & Accessibility
- [x] External content blocked by default
- [x] HTML sanitization with DOMPurify
- [x] User control for loading external content
- [x] Trusted senders list for automatic image loading
- [x] Dark mode email readability (intelligent color transformation)
- [x] WCAG 2.0 Level AA color contrast compliance
- [x] Newsletter unsubscribe support (RFC 2369)
- [x] XSS attack prevention with comprehensive validation

### Identity Management
- [x] Multiple sender identities (name, email, signature)
- [x] Sub-addressing support (user+tag@domain.com)
- [x] Per-identity signatures
- [x] Identity badges in email viewer and list
- [x] Tag suggestions based on context

### Testing
- [x] Unit tests for validation utilities (57 tests)
- [x] Unit tests for email sanitization
- [x] Unit tests for color transformation
- [x] XSS attack vector testing

### Deployment
- [x] Runtime environment variables (Docker-friendly configuration)

## Planned Features

### Address Book & Contacts
- [ ] Contact store with CRUD operations
- [ ] Contacts list view with search/filter
- [ ] Contact details view/edit form
- [ ] Contact groups management
- [ ] vCard import/export
- [ ] JMAP contacts sync (if server supports)
- [ ] Email autocomplete from contacts
- [ ] Contacts integration in composer

### Advanced Features
- [ ] Email filters and rules
- [ ] Calendar integration (JMAP Calendars)
- [ ] Email templates
- [ ] Vacation responder settings
- [ ] Advanced search with filters
- [ ] Email encryption (PGP/GPG)

### Performance Optimizations
- [ ] Virtual scrolling for large lists
- [ ] Email content caching
- [ ] Bundle size optimization
- [ ] Service worker for offline support
- [ ] Lazy loading for attachments

### Testing (Remaining)
- [ ] Component tests
- [ ] E2E tests with Playwright
- [ ] Accessibility testing
- [ ] Performance testing

### Deployment
- [x] Health check endpoint
- [ ] Docker containerization
- [ ] Production build optimizations
- [ ] Monitoring and logging

### Security Enhancements
- [ ] CSP headers configuration
- [ ] Additional XSS protection layers
- [ ] Rate limiting
- [ ] CORS configuration

## Known Issues

- [ ] Next.js workspace root warning (cosmetic)

## Contributing

Want to help implement a feature? Check out our [CONTRIBUTING.md](CONTRIBUTING.md) guide!
