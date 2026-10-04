const key = process.env.GEMINI_API_KEY;

if (!key) {
  console.log("GEMINI_API_KEY NOT FOUND");
  process.exit(1);
}

console.log("Testing Gemini key from .env...");
console.log("Key length:", key.length);
console.log("Key prefix:", key.slice(0, 6));
console.log("Key suffix:", key.slice(-4));

const response = await fetch(
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: "Reply with exactly: GEMINI TEST OK" }
          ]
        }
      ]
    })
  }
);

console.log("HTTP STATUS:", response.status);
console.log(await response.text());
