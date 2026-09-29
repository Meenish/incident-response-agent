const BACKEND_URL = 'https://earnings-mounting-potential-extract.trycloudflare.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, BACKEND_URL);

    return fetch(new Request(target, request));
  }
};
