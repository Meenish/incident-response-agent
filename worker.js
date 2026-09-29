const BACKEND_URL = 'https://sturdy-broccoli-r4jvw6j6j7wfpj55-3000.app.github.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, BACKEND_URL);

    return fetch(new Request(target, request));
  }
};
