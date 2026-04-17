# @sprintable/sdk

Sprintable API client for agents and external applications.

## Installation

```bash
pnpm add @sprintable/sdk
```

## Usage

### Basic Example

```typescript
import { createSprintableClient } from '@sprintable/sdk';

const client = createSprintableClient('sk_live_your_api_key');

// Using typed methods
const story = await client.stories.get('story-id');
console.log(story.title);

const memos = await client.memos.list({ status: 'open', limit: 10 });
console.log(memos);

const reply = await client.memos.reply('memo-id', 'Great work!');
console.log(reply);

// Using raw axios instance
const { data } = await client.axios.get('/api/custom-endpoint');
console.log(data);
```

### Typed Methods

#### Stories

```typescript
// Get a story by ID
const story = await client.stories.get('story-id');
```

#### Memos

```typescript
// Get a memo by ID
const memo = await client.memos.get('memo-id');

// List memos with filters
const memos = await client.memos.list({
  status: 'open',
  assigned_to: 'user-id',
  q: 'search query',
  limit: 20,
  cursor: 'cursor-token',
});

// Reply to a memo (simple string)
const reply = await client.memos.reply('memo-id', 'Reply content');

// Reply with object
const reply2 = await client.memos.reply('memo-id', {
  content: 'Looks good!',
});
```

### Custom Base URL

```typescript
const client = createSprintableClient('sk_live_your_api_key', {
  baseURL: 'http://localhost:3000',
});
```

### Custom Axios Configuration

```typescript
const client = createSprintableClient('sk_live_your_api_key', {
  axiosConfig: {
    timeout: 10000,
    headers: {
      'X-Custom-Header': 'value',
    },
  },
});
```

## API

### `createSprintableClient(apiKey, options?)`

Creates a configured Sprintable API client.

**Parameters:**
- `apiKey` (string): Your Sprintable API key (e.g., `sk_live_...`)
- `options` (SprintableClientOptions, optional):
  - `baseURL` (string): Base URL for API requests. Required — your Sprintable deployment URL (e.g., `https://your-domain.example.com`)
  - `axiosConfig` (AxiosRequestConfig): Additional axios configuration

**Returns:**
- `SprintableClient`: Client instance with `axios` and `apiKey` properties

**Features:**
- Automatic `Authorization: Bearer <apiKey>` header injection
- Pre-configured base URL and content type
- Full axios API support
- TypeScript support with type definitions

## License

MIT
