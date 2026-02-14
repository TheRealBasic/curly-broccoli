import { APP_NAME } from '@curly-broccoli/shared';

export function App() {
  const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>Web app says hello.</p>
      <p>
        Next stage: realtime chat. API expected at <code>{apiBase}</code>
      </p>
    </main>
  );
}
