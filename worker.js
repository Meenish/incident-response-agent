export default {
  async fetch(request) {
    return new Response(
      JSON.stringify({
        status: "ok",
        service: "Incident Response Agent"
      }),
      {
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }
};