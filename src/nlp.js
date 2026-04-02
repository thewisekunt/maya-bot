/**
 * nlp.js — Intent classifier using NLP.js (node-nlp)
 *
 * Local neural intent classifier with English + Hinglish support.
 * Used to decide how maya should respond in different contexts.
 */

import { NlpManager } from 'node-nlp';
import db from './db.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const manager = new NlpManager({
    languages: ['en'],
    forceNER: false,
    nlu: { useNoneFeature: true, log: false },
    ner: { useDuckling: false },
});

let _trained = false;
let _training = null;

// Cross-platform model cache
const MODEL_PATH = process.env.NLP_MODEL_PATH ||
    path.join(os.tmpdir(), 'maya_nlp_model.json');

// ── Training Data ─────────────────────────────────────────────────────────────
function _addTrainingData() {
    // question_to_maya — directly addressing her
    const qtc = [
        'what do you think', 'maya what do you think', 'lsd what do you think',
        'your opinion', 'do you agree', 'what would you do', 'can you help me',
        'maya bata', 'lsd bata', 'tera kya scene hai', 'kya lagta hai tujhe',
        'tu kya sochti hai', 'maya help kar', 'lsd ek suggestion de',
        'maya' // legacy mentions (will be treated as addressing her)
    ];
    qtc.forEach(u => manager.addDocument('en', u, 'question_to_maya'));

    // question_to_group — open question to the room
    const qtg = [
        'does anyone know', 'has anyone tried', 'what do you guys think',
        'koi bata sakta hai', 'kisi ko pata hai', 'sab ka kya opinion hai',
        'guys kya lagta hai', 'bhai log kya sochte ho'
    ];
    qtg.forEach(u => manager.addDocument('en', u, 'question_to_group'));

    // emotional — venting / distress
    const emo = [
        'i feel so sad', 'i am depressed', 'i feel alone', 'bahut bura lag raha hai',
        'dil nahi kar raha', 'bahut stressed hoon', 'rona aa raha hai',
        'sab galat ho raha hai', 'koi samajhta nahi'
    ];
    emo.forEach(u => manager.addDocument('en', u, 'emotional'));

    // directed_at_other — talking to/about someone else
    const dao = [
        'bro what are you doing', 'bhai tu kya kar raha hai', 'tell him',
        'ask her', 'yaar tu pagal hai', 'bhai chill kar'
    ];
    dao.forEach(u => manager.addDocument('en', u, 'directed_at_other'));

    // random_mention — name dropped in passing
    const rm = [
        'maya was saying', 'lsd ne kaha tha', 'maya told me',
        'like maya said', 'lsd wali baat'
    ];
    rm.forEach(u => manager.addDocument('en', u, 'random_mention'));

    // engaged_reply — short back-and-forth
    const er = [
        'yeah exactly', 'no way', 'i know right', 'haan bilkul', 'sach mein',
        'theek hai', 'hmm sahi hai', 'lol ok', 'bruh'
    ];
    er.forEach(u => manager.addDocument('en', u, 'engaged_reply'));

    // group_chatter — general noise
    const gc = [
        'lol', 'haha', 'bruh', 'mid', 'sus', 'cooked', 'fr', 'ong', 'bet',
        'kuch nahi yaar', 'bore ho raha hoon', 'kha raha hoon', 'gm', 'gn'
    ];
    gc.forEach(u => manager.addDocument('en', u, 'group_chatter'));
}

// ── Train NLP ───────────────────────────────────────────────────────────────
export async function trainNLP() {
    if (_trained) return;
    if (_training) return _training;

    _training = (async () => {
        const start = Date.now();

        // Try loading saved model first
        if (fs.existsSync(MODEL_PATH)) {
            try {
                const saved = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
                await manager.import(saved);
                _trained = true;
                console.log(`[nlp] Loaded saved model in ${Date.now() - start}ms`);
                return;
            } catch (e) {
                console.warn('[nlp] Failed to load saved model, retraining...');
            }
        }

        console.log('[nlp] Training intent classifier...');
        _addTrainingData();
        await manager.train();
        _trained = true;

        console.log(`[nlp] Training completed in ${Date.now() - start}ms`);
        _saveModel();
    })();

    return _training;
}

function _saveModel() {
    try {
        const exported = manager.export(false);
        fs.writeFileSync(MODEL_PATH, JSON.stringify(exported));
        console.log(`[nlp] Model saved to ${MODEL_PATH}`);
    } catch (e) {
        console.warn('[nlp] Could not save model:', e.message);
    }
}

// ── Retrain with new data from DB (used by dream.js) ───────────────────────
export async function retrainFromDB() {
    try {
        const [rows] = await db.execute(`
            SELECT id, text, intent 
            FROM maya_nlp_training 
            WHERE used_in_train = 0 
              AND LENGTH(text) >= 3 
              AND LENGTH(text) <= 300
            ORDER BY created_at ASC 
            LIMIT 200
        `);

        if (!rows.length) return 0;

        console.log(`[nlp] Retraining with ${rows.length} new examples...`);
        for (const row of rows) {
            manager.addDocument('en', row.text.toLowerCase(), row.intent);
        }

        await manager.train();
        _saveModel();

        const ids = rows.map(r => r.id);
        await db.execute(
            `UPDATE maya_nlp_training SET used_in_train = 1 
             WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );

        return rows.length;
    } catch (e) {
        console.error('[nlp] Retrain failed:', e.message);
        return 0;
    }
}

// ── Classify message ───────────────────────────────────────────────────────
export async function classify(text) {
    if (!_trained) {
        return { intent: 'group_chatter', score: 0.5, sentiment: 'neutral', sentimentScore: 0 };
    }

    try {
        const result = await manager.process('en', text.toLowerCase().trim());
        return {
            intent: result.intent || 'group_chatter',
            score: result.score || 0.5,
            sentiment: result.sentiment?.vote || 'neutral',
            sentimentScore: result.sentiment?.score || 0,
        };
    } catch (e) {
        console.error('[nlp] Classify error:', e.message);
        return { intent: 'group_chatter', score: 0.5, sentiment: 'neutral', sentimentScore: 0 };
    }
}

export async function getSentiment(text) {
    if (!_trained) return { vote: 'neutral', score: 0 };

    try {
        const result = await manager.process('en', text.toLowerCase().trim());
        return {
            vote: result.sentiment?.vote || 'neutral',
            score: result.sentiment?.score || 0
        };
    } catch {
        return { vote: 'neutral', score: 0 };
    }
}