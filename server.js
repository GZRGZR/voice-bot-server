const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// נתיב בדיקה כדי לראות שהשרת עובד
app.get('/', (req, res) => {
    res.send('שרת הבוט הקולי עובד בהצלחה!');
});

// ה-API של גוגל לחיבור Live
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

// ראוט: Twilio מתקשר לשרת שלנו
app.post('/incoming-call', (req, res) => {
    console.log("=== התקבלה שיחה חדשה מ-Twilio! ===");
    res.type('text/xml');
    
    // שולף את כתובת השרת שלנו (כדי ש-Twilio ידע לאן לשלוח את האודיו)
    const host = req.headers.host;
    
    const twiml = `
    <Response>
        <Say language="he-IL">מתחבר למערכת. אנא המתן.</Say>
        <Connect>
            <Stream url="wss://${host}/media-stream" />
        </Connect>
    </Response>`;
    
    res.send(twiml);
});

// ראוט: ערוץ האודיו החי
wss.on('connection', (twilioWs, req) => {
    if (req.url !== '/media-stream') {
        return twilioWs.close();
    }

    console.log("Twilio התחבר בהצלחה לערוץ האודיו.");
    const geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', () => {
        console.log("החיבור לגוגל הוקם בהצלחה.");
        const setupMessage = {
            setup: {
                model: "models/gemini-2.0-flash-exp",
                systemInstruction: {
                    parts:[{ text: "אתה עוזר קולי בעברית לניהול רשימות. ענה קצרות ובתכליתיות." }]
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMessage));
    });

    // מעביר אודיו מהטלפון לגוגל
    twilioWs.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'media') {
            const audioMessage = {
                realtimeInput: {
                    mediaChunks:[{
                        mimeType: "audio/pcm;rate=8000",
                        data: msg.media.payload
                    }]
                }
            };
            if (geminiWs.readyState === WebSocket.OPEN) {
                geminiWs.send(JSON.stringify(audioMessage));
            }
        }
    });

    // מעביר תשובות מגוגל בחזרה לטלפון
    geminiWs.on('message', (data) => {
        const response = JSON.parse(data);
        if (response.serverContent && response.serverContent.modelTurn) {
            const parts = response.serverContent.modelTurn.parts;
            parts.forEach(part => {
                if (part.inlineData && part.inlineData.data) {
                    const mediaMessage = {
                        event: 'media',
                        media: { payload: part.inlineData.data }
                    };
                    twilioWs.send(JSON.stringify(mediaMessage));
                }
            });
        }
    });

    twilioWs.on('close', () => {
        console.log("השיחה נותקה.");
        geminiWs.close();
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`השרת רץ על פורט ${PORT}`);
});
