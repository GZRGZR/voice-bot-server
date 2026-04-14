const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { WaveFile } = require('wavefile'); // ספריית המרת האודיו שלנו

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// פתרון בעיה 1 של GPT: ניתוח גוף הבקשה ש-Twilio שולח
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
    res.send('שרת הבוט הקולי רץ ומוכן לשיחות! (גרסה משודרגת)');
});

// נתיב ה-API של גוגל
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

// קבלת השיחה מ-Twilio
app.post('/incoming-call', (req, res) => {
    console.log("=== התקבלה שיחה חדשה מ-Twilio ===");
    res.type('text/xml');
    
    const host = req.headers.host;
    
    // אנו מנחים את Twilio לפתוח Stream. אין צורך לומר "אנא המתן" כי החיבור הוא מיידי.
    const twiml = `
    <Response>
        <Connect>
            <Stream url="wss://${host}/media-stream" />
        </Connect>
    </Response>`;
    
    res.send(twiml);
});

// ניהול ערוץ ה-WebSocket של האודיו החי
wss.on('connection', (twilioWs, req) => {
    // פתרון בעיה 2 של GPT: בדיקה נכונה של ה-URL כולל פרמטרים
    if (!req.url.startsWith('/media-stream')) {
        return twilioWs.close();
    }

    console.log("Twilio מחובר לערוץ האודיו (WebSocket). מתחבר לגוגל...");
    
    let streamSid = null; // ישמור את ה-ID של ערוץ האודיו מול Twilio

    // פתיחת חיבור מול גוגל
    const geminiWs = new WebSocket(GEMINI_WS_URL);

    geminiWs.on('open', () => {
        console.log("מחובר בהצלחה ל-Gemini Live API.");
        
        // הגדרת המודל - אנו אומרים לו שאנו עובדים ב-16000 הרץ
        const setupMessage = {
            setup: {
                model: "models/gemini-2.0-flash-exp",
                systemInstruction: {
                    parts:[{ text: "אתה עוזר אישי קולי לניהול רשימות בעברית. ענה תמיד בקצרה ובתכליתיות, בלי פטפטת מיותרת." }]
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMessage));
    });

    // פתרון בעיה 5 של GPT: טיפול בשגיאות מול גוגל
    geminiWs.on('error', (err) => {
        console.error("שגיאה בחיבור ל-Gemini:", err.message);
    });

    // קבלת נתונים מ-Twilio (הלקוח מדבר)
    twilioWs.on('message', (message) => {
        const msg = JSON.parse(message);
        
        // פתרון בעיה 4 של GPT: טיפול באירועי start ו-stop
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            console.log(`הזרמת אודיו החלה. StreamSid: ${streamSid}`);
        } 
        else if (msg.event === 'media') {
            // פתרון בעיה 3 של GPT: המרת mulaw 8000Hz ל-PCM 16000Hz עבור גוגל
            const twilioPayload = msg.media.payload;
            const mulawBuffer = Buffer.from(twilioPayload, 'base64');
            
            try {
                // שימוש ב-WaveFile להמרת האודיו
                let wav = new WaveFile();
                wav.fromScratch(1, 8000, '8m', mulawBuffer); // טעינת המקור מ-Twilio
                wav.toSampleRate(16000); // המרה ל-16kHz שגוגל אוהב
                wav.toBitDepth('16'); // המרה ל-16 ביט
                
                const pcmBase64 = Buffer.from(wav.data.samples).toString('base64');

                // שליחה לגוגל
                const audioMessage = {
                    realtimeInput: {
                        mediaChunks:[{
                            mimeType: "audio/pcm;rate=16000",
                            data: pcmBase64
                        }]
                    }
                };
                
                if (geminiWs.readyState === WebSocket.OPEN) {
                    geminiWs.send(JSON.stringify(audioMessage));
                }
            } catch (err) {
                console.error("שגיאה בהמרת אודיו מגוגל ל-Twilio:", err.message);
            }
        }
        else if (msg.event === 'stop') {
            console.log("Twilio סגר את הזרמת האודיו.");
            if (geminiWs.readyState === WebSocket.OPEN) {
                geminiWs.close();
            }
        }
    });

    // פתרון בעיה 5 של GPT: טיפול בשגיאות מול Twilio
    twilioWs.on('error', (err) => {
        console.error("שגיאה בחיבור ל-Twilio:", err.message);
    });

    // קבלת תשובות קוליות מגוגל והחזרתן ל-Twilio (המודל עונה)
    geminiWs.on('message', (data) => {
        const response = JSON.parse(data);
        
        if (response.serverContent && response.serverContent.modelTurn) {
            const parts = response.serverContent.modelTurn.parts;
            parts.forEach(part => {
                if (part.inlineData && part.inlineData.data) {
                    // גוגל שולח PCM ב-24000Hz. חייבים להמיר חזרה ל-mulaw 8000Hz עבור Twilio!
                    const geminiAudioBase64 = part.inlineData.data;
                    const geminiBuffer = Buffer.from(geminiAudioBase64, 'base64');
                    
                    try {
                        let wavOut = new WaveFile();
                        wavOut.fromScratch(1, 24000, '16', geminiBuffer); // המקור מגוגל
                        wavOut.toSampleRate(8000); // הורדת איכות למה שטלפון מבין
                        wavOut.toBitDepth('8m'); // המרה ל-mulaw
                        
                        const mulawBase64 = Buffer.from(wavOut.data.samples).toString('base64');
                        
                        // שליחה ל-Twilio להשמעה ללקוח
                        const mediaMessage = {
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: mulawBase64 }
                        };
                        
                        if (twilioWs.readyState === WebSocket.OPEN) {
                            twilioWs.send(JSON.stringify(mediaMessage));
                        }
                    } catch (err) {
                        console.error("שגיאה בהמרת אודיו מגוגל ל-Twilio:", err.message);
                    }
                }
            });
        }
    });

    twilioWs.on('close', () => {
        console.log("השיחה מול Twilio נותקה סופית.");
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`השרת (גרסת Pro) רץ על פורט ${PORT}`);
});
