// --- CONFIGURAÇÃO DO BANCO DE DADOS LOCAL (IndexedDB) ---
const dbName = "AWSSimulatorDB_v2"; // Nova versão do banco de dados para evitar conflitos
const storeName = "questions";
const dbVersion = 1;

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(storeName)) {
                const store = db.createObjectStore(storeName, { keyPath: "id", autoIncrement: true });
                store.createIndex("certification", "certification", { unique: false });
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

function clearQuestionsByTrackInDB(track) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readwrite");
            const store = tx.objectStore(storeName);
            const index = store.index("certification");
            const request = index.openCursor(IDBKeyRange.only(track));
            
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = (e) => reject(request.error);
        });
    });
}

function saveQuestionsToDB(questions, track) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readwrite");
            const store = tx.objectStore(storeName);
            
            questions.forEach(q => {
                const item = { ...q, certification: track };
                // Se o item já tiver um ID personalizado (hash), o store.put() atualiza/insere usando ele
                store.put(item);
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    });
}

function loadQuestionsByTrackFromDB(track) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readonly");
            const store = tx.objectStore(storeName);
            const index = store.index("certification");
            const req = index.getAll(IDBKeyRange.only(track));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    });
}

function loadAllQuestionsCountFromDB() {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, "readonly");
            const store = tx.objectStore(storeName);
            const req = store.getAll();
            req.onsuccess = () => {
                const all = req.result;
                const counts = {
                    practitioner: all.filter(q => q.certification === "practitioner").length,
                    associate: all.filter(q => q.certification === "associate").length,
                    professional: all.filter(q => q.certification === "professional").length
                };
                resolve(counts);
            };
            req.onerror = () => reject(req.error);
        });
    });
}


// --- ESTADO GLOBAL DO APLICATIVO ---
const state = {
    // Trilha Ativa
    activeTrack: "associate", // 'practitioner' | 'associate' | 'professional'
    
    // Sincronização automática de trilhas locais
    syncedTracks: new Set(),
    
    // Questões carregadas da trilha ativa
    questions: [],
    fridge: new Set(), // IDs de questões na geladeira para a trilha ativa
    
    // Perfil Global e Perfis por Trilha
    userName: "",
    adminActive: false,
    
    profiles: {
        practitioner: {
            level: "amador",
            consecutiveIntCount: 0,
            consecutiveProfCount: 0,
            bestScore: 0,
            history: [],
            fridge: new Set()
        },
        associate: {
            level: "amador",
            consecutiveIntCount: 0,
            consecutiveProfCount: 0,
            bestScore: 0,
            history: [],
            fridge: new Set()
        },
        professional: {
            level: "amador",
            consecutiveIntCount: 0,
            consecutiveProfCount: 0,
            bestScore: 0,
            history: [],
            fridge: new Set()
        }
    },
    
    // Gamificação e Missões
    missions: {},
    consecutiveSeiCount: 0,
    
    // Contagem global rápida para trilhas
    trackCounts: {
        practitioner: 0,
        associate: 0,
        professional: 0
    },
    
    // Simulado atual em andamento
    currentQuiz: [],
    currentQuestionIndex: 0,
    selectedOption: null,
    selectedConfidence: null,
    userAnswers: [],
    
    // Timer
    timerInterval: null,
    timerSeconds: 0
};


// --- PALAVRAS-CHAVE PARA AUTODETECÇÃO DE DOMÍNIOS (SAA-C03) ---
const DOMAIN_KEYWORDS = {
    1: ["secure", "security", "iam", "kms", "encrypt", "firewall", "vpc", "waf", "shield", "cognito", "secrets", "audit", "policy", "compliant", "compliance", "sign", "credentials", "private", "certificate", "seguran", "criptogra", "auditoria", "autoriz", "autentic"],
    2: ["resilient", "multi-az", "backup", "disaster", "recovery", "route 53", "route53", "auto scaling", "autoscaling", "elb", "load balancer", "balancer", "aurora", "replication", "failover", "snapshot", "durable", "resilien", "alta disponibil", "redundancia", "toleran", "fault-tolerant"],
    3: ["performance", "latency", "throughput", "iops", "cache", "elasticache", "cloudfront", "ssd", "instance type", "hpc", "parallel", "athena", "redshift", "efs", "glacier", "latencia", "desempenho", "velocidade", "throughput", "io", "memoria"],
    4: ["cost", "price", "savings", "budget", "spot", "serverless", "lambda", "intelligent-tiering", "cheap", "expense", "billing", "cost-effective", "custo", "preco", "faturamento", "otimiz", "econom"]
};

function autoDetectDomain(questionText, optionsText = "") {
    const combined = `${questionText} ${optionsText}`.toLowerCase();
    
    let scores = { 1: 0, 2: 0, 3: 0, 4: 0 };
    
    // Contar matches de palavras-chave
    for (let dom in DOMAIN_KEYWORDS) {
        DOMAIN_KEYWORDS[dom].forEach(keyword => {
            if (combined.includes(keyword)) {
                scores[dom]++;
            }
        });
    }
    
    // Encontrar o domínio com maior score
    let bestDomain = 1; // Default
    let maxScore = -1;
    
    for (let dom in scores) {
        if (scores[dom] > maxScore) {
            maxScore = scores[dom];
            bestDomain = parseInt(dom);
        }
    }
    
    // Se não houver matches significativos, distribuir
    if (maxScore === 0) {
        // Retorna um domínio baseado em uma soma simples dos caracteres para estabilidade (mesma pergunta sempre dá o mesmo domínio)
        const sum = questionText.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
        bestDomain = (sum % 4) + 1;
    }
    
    return bestDomain;
}

// --- FUNÇÃO HASH DETERMINÍSTICA PARA IDs DE QUESTÕES ---
function generateQuestionId(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Converte para inteiro de 32 bits
    }
    return "q_" + Math.abs(hash).toString(36);
}

// --- PARSER DE TEXTO ATUALIZADO COM DOMÍNIOS ---
function parseTXTQuestions(text) {
    const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    const questionSplitRegex = /(?:^|\n)(?=\d+[\.\-\)]|\bQuest[aã]o\s+\d+|\bQuestion\s+\d+)/i;
    const blocks = normalizedText.split(questionSplitRegex);
    const parsedQuestions = [];
    
    for (let block of blocks) {
        block = block.trim();
        if (!block) continue;
        
        // --- PARSER PARA QUESTÕES EM LINHA ÚNICA (INLINE) ---
        const hasOptionsInline = /\bA[\)\.\-\s]+/.test(block) && /(?:resposta|gabarito|answer|correct|correta)\s*[:\-]?\s*[A-E]/i.test(block);
        if (hasOptionsInline) {
            let answer = "";
            let domain = null;
            
            const ansM = block.match(/(?:resposta|gabarito|answer|correct|correta)\s*[:\-]?\s*([A-E](?:\s*(?:e|and|ou|or)\s*[A-E])?)/i);
            if (ansM) answer = ansM[1].toUpperCase().trim();
            
            const domM = block.match(/(?:dom[ií]nio|domain|d)\s*[:\-]?\s*([1-4])/i);
            if (domM) domain = parseInt(domM[1]);
            
            let cleanLine = block.replace(/(?:resposta|gabarito|answer|correct|correta)\s*[:\-]?\s*([A-E](?:\s*(?:e|and|ou|or)\s*[A-E])?)/i, '')
                                 .replace(/(?:dom[ií]nio|domain|d)\s*[:\-]?\s*([1-4])/i, '')
                                 .trim();
            
            let questionText = "";
            const options = {};
            
            const match5 = cleanLine.match(/^(.*?)\bA[\)\.\-\s]+(.*?)\bB[\)\.\-\s]+(.*?)\bC[\)\.\-\s]+(.*?)\bD[\)\.\-\s]+(.*?)\bE[\)\.\-\s]+(.*?)$/i);
            const match4 = cleanLine.match(/^(.*?)\bA[\)\.\-\s]+(.*?)\bB[\)\.\-\s]+(.*?)\bC[\)\.\-\s]+(.*?)\bD[\)\.\-\s]+(.*?)$/i);
            
            if (match5) {
                questionText = match5[1].trim();
                options["A"] = match5[2].trim();
                options["B"] = match5[3].trim();
                options["C"] = match5[4].trim();
                options["D"] = match5[5].trim();
                options["E"] = match5[6].trim();
            } else if (match4) {
                questionText = match4[1].trim();
                options["A"] = match4[2].trim();
                options["B"] = match4[3].trim();
                options["C"] = match4[4].trim();
                options["D"] = match4[5].trim();
            }
            
            questionText = questionText.replace(/^(\d+[\.\-\)]\s*)/, '')
                                       .replace(/^(Quest[aã]o\s+\d+[\.\-\s:]*)/i, '');
            
            if (domain === null) {
                const optionsString = Object.values(options).join(" ");
                domain = autoDetectDomain(questionText, optionsString);
            }
            
            if (questionText && Object.keys(options).length >= 2 && answer) {
                const qId = generateQuestionId(questionText);
                parsedQuestions.push({
                    id: qId,
                    text: questionText,
                    options: options,
                    answer: answer,
                    domain: domain
                });
                continue; // Processado com sucesso como inline!
            }
        }
        
        // --- PARSER TRADICIONAL PARA MÚLTIPLAS LINHAS ---
        const lines = block.split('\n').map(l => l.trim()).filter(l => l !== '');
        if (lines.length < 3) continue;
        
        let questionText = "";
        const options = {};
        let answer = "";
        let domain = null;
        
        const optionRegex = /^([A-E])[\)\.\-\s]+(.*)$/i;
        const answerRegex = /(?:resposta|gabarito|answer|correct|correta)\s*[:\-]?\s*([A-E])/i;
        const domainRegex = /(?:dom[ií]nio|domain|d)\s*[:\-]?\s*([1-4])/i;
        
        let questionLines = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Verificar domínio explicitamente configurado
            const domainMatch = line.match(domainRegex);
            if (domainMatch) {
                domain = parseInt(domainMatch[1]);
                continue;
            }
            
            // Verificar gabarito
            const answerMatch = line.match(answerRegex);
            if (answerMatch) {
                answer = answerMatch[1].toUpperCase();
                continue;
            }
            
            // Verificar alternativa
            const optionMatch = line.match(optionRegex);
            if (optionMatch) {
                const optLetter = optionMatch[1].toUpperCase();
                const optText = optionMatch[2].trim();
                options[optLetter] = optText;
                continue;
            }
            
            // Texto da questão
            if (Object.keys(options).length === 0) {
                questionLines.push(line);
            }
        }
        
        let fullQuestionText = questionLines.join(' ');
        fullQuestionText = fullQuestionText.replace(/^(\d+[\.\-\)]\s*)/, '');
        fullQuestionText = fullQuestionText.replace(/^(Quest[aã]o\s+\d+[\.\-\s:]*)/i, '');
        
        // Se não encontrou o domínio no txt, autodetecta
        if (domain === null) {
            const optionsString = Object.values(options).join(" ");
            domain = autoDetectDomain(fullQuestionText, optionsString);
        }
        
        if (fullQuestionText && Object.keys(options).length >= 2 && answer) {
            const qId = generateQuestionId(fullQuestionText);
            parsedQuestions.push({
                id: qId,
                text: fullQuestionText,
                options: options,
                answer: answer,
                domain: domain
            });
        }
    }
    
    return parsedQuestions;
}


// --- SISTEMA MULTI-JOGADOR E PERSISTÊNCIA ---
const PLAYERS_LIST_KEY = "aws_simulator_player_list";
const PLAYER_PREFIX = "aws_simulator_player_";

function getPlayersList() {
    try {
        const raw = localStorage.getItem(PLAYERS_LIST_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch(e) {
        return [];
    }
}

function savePlayersList(list) {
    localStorage.setItem(PLAYERS_LIST_KEY, JSON.stringify(list));
}

function migrateOldProfile() {
    const rawOld = localStorage.getItem("aws_simulator_multi_profile");
    if (rawOld) {
        try {
            const parsed = JSON.parse(rawOld);
            const name = parsed.userName || "Estudante";
            
            const list = getPlayersList();
            if (!list.includes(name)) {
                list.push(name);
                savePlayersList(list);
            }
            
            const playerProfile = {
                userName: name,
                profiles: {
                    practitioner: parsed.profiles?.practitioner || { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: [] },
                    associate:    parsed.profiles?.associate    || { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: [] },
                    professional: parsed.profiles?.professional || { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: [] }
                },
                missions: {
                    M1: { progress: 0, completed: false, completedAt: null },
                    M2: { progress: 0, completed: false, completedAt: null },
                    M3: { progress: 0, completed: false, completedAt: null },
                    M4: { progress: 0, completed: false, completedAt: null },
                    M5: { progress: 0, completed: false, completedAt: null },
                    M6: { progress: 0, completed: false, completedAt: null },
                    M7: { progress: 0, completed: false, completedAt: null }
                },
                consecutiveSeiCount: 0
            };
            
            localStorage.setItem(PLAYER_PREFIX + name, JSON.stringify(playerProfile));
            localStorage.removeItem("aws_simulator_multi_profile");
            console.log(`Migrado perfil antigo de ${name} com sucesso!`);
        } catch(e) {
            console.error("Erro na migração do perfil antigo:", e);
        }
    }
}

function saveProfileToLocalStorage() {
    if (!state.userName) return;
    
    const dataToSave = {
        userName: state.userName,
        profiles: {
            practitioner: {
                level: state.profiles.practitioner.level,
                consecutiveIntCount: state.profiles.practitioner.consecutiveIntCount,
                consecutiveProfCount: state.profiles.practitioner.consecutiveProfCount,
                bestScore: state.profiles.practitioner.bestScore,
                history: state.profiles.practitioner.history,
                fridge: Array.from(state.profiles.practitioner.fridge || [])
            },
            associate: {
                level: state.profiles.associate.level,
                consecutiveIntCount: state.profiles.associate.consecutiveIntCount,
                consecutiveProfCount: state.profiles.associate.consecutiveProfCount,
                bestScore: state.profiles.associate.bestScore,
                history: state.profiles.associate.history,
                fridge: Array.from(state.profiles.associate.fridge || [])
            },
            professional: {
                level: state.profiles.professional.level,
                consecutiveIntCount: state.profiles.professional.consecutiveIntCount,
                consecutiveProfCount: state.profiles.professional.consecutiveProfCount,
                bestScore: state.profiles.professional.bestScore,
                history: state.profiles.professional.history,
                fridge: Array.from(state.profiles.professional.fridge || [])
            }
        },
        missions: state.missions || {},
        consecutiveSeiCount: state.consecutiveSeiCount || 0
    };
    
    localStorage.setItem(PLAYER_PREFIX + state.userName, JSON.stringify(dataToSave));
}

function loadProfileFromLocalStorage() {
    const lastPlayer = localStorage.getItem("aws_simulator_last_player");
    if (lastPlayer) {
        loginPlayer(lastPlayer, false);
    } else {
        showWelcomeScreen();
    }
}

function loginPlayer(name, showWelcomeMessage = false) {
    const raw = localStorage.getItem(PLAYER_PREFIX + name);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            state.userName = parsed.userName;
            
            ["practitioner", "associate", "professional"].forEach(track => {
                if (parsed.profiles && parsed.profiles[track]) {
                    state.profiles[track].level = parsed.profiles[track].level || "amador";
                    state.profiles[track].consecutiveIntCount = parsed.profiles[track].consecutiveIntCount || 0;
                    state.profiles[track].consecutiveProfCount = parsed.profiles[track].consecutiveProfCount || 0;
                    state.profiles[track].bestScore = parsed.profiles[track].bestScore || 0;
                    state.profiles[track].history = parsed.profiles[track].history || [];
                    state.profiles[track].fridge = new Set(parsed.profiles[track].fridge || []);
                }
            });
            
            state.missions = parsed.missions || {
                M1: { progress: 0, completed: false, completedAt: null },
                M2: { progress: 0, completed: false, completedAt: null },
                M3: { progress: 0, completed: false, completedAt: null },
                M4: { progress: 0, completed: false, completedAt: null },
                M5: { progress: 0, completed: false, completedAt: null },
                M6: { progress: 0, completed: false, completedAt: null },
                M7: { progress: 0, completed: false, completedAt: null }
            };
            
            state.consecutiveSeiCount = parsed.consecutiveSeiCount || 0;
            
            localStorage.setItem("aws_simulator_last_player", name);
            closeNewPlayerModal();
            
            showSection("dashboardSection");
            refreshState();
            
            if (showWelcomeMessage) {
                alert(`Bem-vindo, ${name}!`);
            }
        } catch (e) {
            console.error("Erro ao carregar dados do jogador:", e);
            showWelcomeScreen();
        }
    } else {
        showWelcomeScreen();
    }
}

function showWelcomeScreen() {
    state.userName = "";
    localStorage.removeItem("aws_simulator_last_player");
    
    const headerWidget = document.getElementById("headerUserWidget");
    if (headerWidget) headerWidget.style.display = "none";
    
    const grid = document.getElementById("profileSelectGrid");
    if (grid) {
        grid.innerHTML = "";
        const list = getPlayersList();
        
        list.forEach(name => {
            let level = "Amador";
            const raw = localStorage.getItem(PLAYER_PREFIX + name);
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    const associateLevel = parsed.profiles?.associate?.level || "amador";
                    level = associateLevel.charAt(0).toUpperCase() + associateLevel.slice(1);
                } catch(e){}
            }
            
            const card = document.createElement("div");
            card.className = "profile-select-card";
            const initials = name.trim().slice(0, 2).toUpperCase() || "U";
            card.innerHTML = `
                <div class="profile-select-avatar">${initials}</div>
                <div class="profile-select-name">${name}</div>
                <div class="profile-select-badge">${level}</div>
            `;
            card.addEventListener("click", () => loginPlayer(name));
            grid.appendChild(card);
        });
        
        const newCard = document.createElement("div");
        newCard.className = "profile-select-card profile-new-card";
        newCard.innerHTML = `
            <div class="profile-new-icon">➕</div>
            <div class="profile-select-name" style="margin-top: 0.5rem;">Novo Jogador</div>
        `;
        newCard.addEventListener("click", openNewPlayerModal);
        grid.appendChild(newCard);
    }
    
    showSection("welcomeSection");
}

function openNewPlayerModal() {
    const modal = document.getElementById("newPlayerModal");
    if (modal) {
        modal.classList.add("active");
        const input = document.getElementById("newPlayerNameInput");
        if (input) {
            input.value = "";
            input.focus();
        }
        const err = document.getElementById("newPlayerErrorMsg");
        if (err) err.style.display = "none";
    }
}

function closeNewPlayerModal() {
    const modal = document.getElementById("newPlayerModal");
    if (modal) modal.classList.remove("active");
}

function submitCreatePlayer() {
    const nameInput = document.getElementById("newPlayerNameInput");
    if (!nameInput) return;
    const name = nameInput.value.trim();
    const errorMsg = document.getElementById("newPlayerErrorMsg");
    
    if (!name) {
        if (errorMsg) {
            errorMsg.innerText = "Por favor, digite um nome.";
            errorMsg.style.display = "block";
        }
        return;
    }
    
    const list = getPlayersList();
    if (list.includes(name)) {
        if (errorMsg) {
            errorMsg.innerText = "Este nome de jogador já existe. Escolha outro!";
            errorMsg.style.display = "block";
        }
        return;
    }
    
    const newProfile = {
        userName: name,
        profiles: {
            practitioner: { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: [] },
            associate:    { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: [] },
            professional: { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: [] }
        },
        missions: {
            M1: { progress: 0, completed: false, completedAt: null },
            M2: { progress: 0, completed: false, completedAt: null },
            M3: { progress: 0, completed: false, completedAt: null },
            M4: { progress: 0, completed: false, completedAt: null },
            M5: { progress: 0, completed: false, completedAt: null },
            M6: { progress: 0, completed: false, completedAt: null },
            M7: { progress: 0, completed: false, completedAt: null }
        },
        consecutiveSeiCount: 0
    };
    
    list.push(name);
    savePlayersList(list);
    localStorage.setItem(PLAYER_PREFIX + name, JSON.stringify(newProfile));
    loginPlayer(name, true);
}

// --- GAMIFICAÇÃO: BASE DE MISSÕES ---
const MISSIONS_DB = {
    M1: {
        id: "M1",
        name: "Primeiro Passo",
        desc: "Conclua 1 simulado em qualquer trilha.",
        badge: "🌟",
        badgeName: "Cloud Explorer",
        badgeClass: "badge-blue",
        target: 1
    },
    M2: {
        id: "M2",
        name: "Foco de Soluções",
        desc: "Faça um simulado completo com nota ≥ 70%.",
        badge: "🎯",
        badgeName: "Arquiteto Preciso",
        badgeClass: "badge-orange",
        target: 1
    },
    M3: {
        id: "M3",
        name: "Dominador do SAA",
        desc: "Obtenha ≥ 85% em todos os domínios em um simulado (SAA-C03).",
        badge: "👑",
        badgeName: "Master Architect",
        badgeClass: "badge-purple",
        target: 1
    },
    M4: {
        id: "M4",
        name: "Coração Gelado",
        desc: "Congele 15 questões ou mais na Geladeira (total).",
        badge: "❄️",
        badgeName: "Mestre do Gelo",
        badgeClass: "badge-cyan",
        target: 15
    },
    M5: {
        id: "M5",
        name: "Maratonista AWS",
        desc: "Conclua 3 simulados no total (qualquer trilha).",
        badge: "🛡️",
        badgeName: "Maratonista da Nuvem",
        badgeClass: "badge-gold",
        target: 3
    },
    M6: {
        id: "M6",
        name: "Convicção Máxima",
        desc: "Acerte 10 questões marcadas como \"Sei\" consecutivamente.",
        badge: "⚡",
        badgeName: "Sniper do Cloud",
        badgeClass: "badge-green",
        target: 10
    },
    M7: {
        id: "M7",
        name: "Velocidade da Luz",
        desc: "Conclua um simulado em menos de 20 minutos com nota ≥ 70%.",
        badge: "🚀",
        badgeName: "Cloud Speedrunner",
        badgeClass: "badge-red",
        target: 1
    }
};

function evaluateMissions() {
    if (!state.userName) return [];
    
    const newlyCompleted = [];
    const profiles = state.profiles;
    
    const totalSims = (profiles.practitioner.history?.length || 0) + 
                      (profiles.associate.history?.length || 0) + 
                      (profiles.professional.history?.length || 0);
                      
    const totalFridge = (profiles.practitioner.fridge?.size || profiles.practitioner.fridge?.length || 0) + 
                        (profiles.associate.fridge?.size || profiles.associate.fridge?.length || 0) + 
                        (profiles.professional.fridge?.size || profiles.professional.fridge?.length || 0);
                        
    const allHistory = [
        ...(profiles.practitioner.history || []),
        ...(profiles.associate.history || []),
        ...(profiles.professional.history || [])
    ];
    const hasPassingScore = allHistory.some(h => h.percentage >= 70);
    
    const hasAllDomainsMastered = (profiles.associate.history || []).some(sim => {
        if (!sim.domains) return false;
        let ok = true;
        for (let d = 1; d <= 4; d++) {
            const dst = sim.domains[d];
            if (!dst || dst.total === 0) {
                ok = false;
                break;
            }
            const pct = Math.round((dst.correct / dst.total) * 100);
            if (pct < 85) {
                ok = false;
                break;
            }
        }
        return ok;
    });
    
    const hasSpeedrunPassed = allHistory.some(h => h.percentage >= 70 && h.timeSeconds < 1200);

    if (!state.missions) state.missions = {};
    for (let mKey in MISSIONS_DB) {
        if (!state.missions[mKey]) {
            state.missions[mKey] = { progress: 0, completed: false, completedAt: null };
        }
    }
    
    updateMissionProgress("M1", totalSims);
    updateMissionProgress("M2", hasPassingScore ? 1 : 0);
    updateMissionProgress("M3", hasAllDomainsMastered ? 1 : 0);
    updateMissionProgress("M4", totalFridge);
    updateMissionProgress("M5", totalSims);
    updateMissionProgress("M6", state.consecutiveSeiCount || 0);
    updateMissionProgress("M7", hasSpeedrunPassed ? 1 : 0);
    
    function updateMissionProgress(mId, currentProgress) {
        const m = state.missions[mId];
        const db = MISSIONS_DB[mId];
        
        m.progress = Math.min(db.target, currentProgress);
        
        if (!m.completed && m.progress >= db.target) {
            m.completed = true;
            m.completedAt = new Date().toLocaleString("pt-BR");
            newlyCompleted.push(db);
        }
    }
    
    saveProfileToLocalStorage();
    return newlyCompleted;
}

function renderMissionsUI() {
    const listContainer = document.getElementById("dashboardMissionsList");
    if (!listContainer) return;
    
    listContainer.innerHTML = "";
    if (!state.missions) state.missions = {};
    
    evaluateMissions();
    
    for (let mId in MISSIONS_DB) {
        const db = MISSIONS_DB[mId];
        const stateM = state.missions[mId] || { progress: 0, completed: false };
        const pct = db.target > 0 ? Math.round((stateM.progress / db.target) * 100) : 0;
        
        const item = document.createElement("div");
        item.className = `mission-item ${stateM.completed ? "unlocked" : ""}`;
        item.innerHTML = `
            <div class="mission-badge-container ${db.badgeClass}">
                ${db.badge}
            </div>
            <div class="mission-content">
                <div class="mission-title-row">
                    <span class="mission-title" title="${db.badgeName}">${db.name} (${db.badgeName})</span>
                    <span class="mission-status">${stateM.completed ? "Concluída" : "Pendente"}</span>
                </div>
                <div class="mission-desc">${db.desc}</div>
                <div class="mission-progress-track">
                    <div class="mission-progress-fill" style="width: ${pct}%;"></div>
                </div>
                <div class="mission-progress-text">${stateM.progress} / ${db.target} (${pct}%)</div>
            </div>
        `;
        listContainer.appendChild(item);
    }
}


// --- GERENCIAMENTO DE TELA (SPA) ---
function showSection(sectionId) {
    document.querySelectorAll(".app-section").forEach(sec => {
        sec.classList.remove("active");
    });
    const target = document.getElementById(sectionId);
    if (target) {
        target.classList.add("active");
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
}


// --- ATUALIZAÇÃO DE INTERFACE DO USUÁRIO ---
function refreshState() {
    // Inicializar conjunto de sincronização se não existir
    if (!state.syncedTracks) {
        state.syncedTracks = new Set();
    }
    
    // Se a trilha ainda não foi sincronizada nesta sessão, tenta baixar o arquivo correspondente
    if (!state.syncedTracks.has(state.activeTrack)) {
        state.syncedTracks.add(state.activeTrack);
        
        const trackFilePath = `./questions/${state.activeTrack}.txt`;
        console.log(`Buscando atualizações de questões para ${state.activeTrack} em: ${trackFilePath}`);
        
        fetch(trackFilePath)
            .then(res => {
                if (!res.ok) throw new Error(`Arquivo não encontrado: ${res.status}`);
                return res.text();
            })
            .then(text => {
                const parsed = parseTXTQuestions(text);
                if (parsed.length > 0) {
                    console.log(`Auto-sincronização bem sucedida: ${parsed.length} questões encontradas para ${state.activeTrack}.`);
                    // Limpar e salvar novamente no banco IndexedDB
                    return clearQuestionsByTrackInDB(state.activeTrack)
                        .then(() => saveQuestionsToDB(parsed, state.activeTrack))
                        .then(() => loadAllQuestionsCountFromDB());
                }
                return loadAllQuestionsCountFromDB();
            })
            .then(counts => {
                if (counts) state.trackCounts = counts;
                return loadQuestionsByTrackFromDB(state.activeTrack);
            })
            .then(activeQuestions => {
                state.questions = activeQuestions || [];
                finishStateUpdate();
            })
            .catch(err => {
                console.warn(`Não foi possível auto-sincronizar ${state.activeTrack}. Usando banco local. Detalhes:`, err.message);
                loadLocalStateOnly();
            });
            
        return; // Interrompe para aguardar o fluxo assíncrono do fetch
    }
    
    loadLocalStateOnly();
}

function loadLocalStateOnly() {
    loadAllQuestionsCountFromDB()
        .then(counts => {
            state.trackCounts = counts;
            return loadQuestionsByTrackFromDB(state.activeTrack);
        })
        .then(activeQuestions => {
            state.questions = activeQuestions || [];
            finishStateUpdate();
        })
        .catch(err => {
            console.error("Erro ao atualizar estado local:", err);
            updateUI();
        });
}

function finishStateUpdate() {
    // Sincronizar geladeira da trilha ativa
    let trackFridge = state.profiles[state.activeTrack].fridge;
    if (!(trackFridge instanceof Set)) {
        trackFridge = new Set(trackFridge || []);
        state.profiles[state.activeTrack].fridge = trackFridge;
    }
    state.fridge = trackFridge;
    
    updateUI();
}

function updateUI() {
    const activeProfile = state.profiles[state.activeTrack];
    
    // Helper para setar innerText com segurança
    function setText(id, val) {
        const el = document.getElementById(id);
        if (el) el.innerText = val;
    }
    function setVal(id, val) {
        const el = document.getElementById(id);
        if (el) el.value = val;
    }
    
    // Sincronizar seletor de trilha do jogador
    const playerTrackSelect = document.getElementById("playerTrackSelect");
    if (playerTrackSelect) playerTrackSelect.value = state.activeTrack;
    
    // Contadores Rápidos do Admin (podem não estar no DOM se admin estiver oculto)
    setText("adminCountPractitioner", state.trackCounts.practitioner);
    setText("adminCountAssociate",    state.trackCounts.associate);
    setText("adminCountProfessional", state.trackCounts.professional);
    
    // Nome do aluno
    setVal("userNameInput", state.userName);
    setText("welcomeTitle",       `Olá, ${state.userName}!`);
    setText("profileNameDisplay", state.userName);
    
    const initial = state.userName.trim().charAt(0).toUpperCase() || "U";
    setText("userAvatar", initial);
    
    // Nível atual (Badge) na trilha ativa
    const badge = document.getElementById("profileBadgeDisplay");
    if (badge) {
        badge.className = "badge";
        badge.classList.add(`badge-${activeProfile.level}`);
        badge.innerText = activeProfile.level.charAt(0).toUpperCase() + activeProfile.level.slice(1);
    }
    
    // Ajustar Borda de Perfil
    const profileCardWrapper = document.getElementById("profileCardWrapper");
    if (profileCardWrapper) {
        profileCardWrapper.className = "profile-gradient-border";
        profileCardWrapper.classList.add(activeProfile.level);
    }
    
    const headerWidget = document.getElementById("headerUserWidget");
    if (headerWidget) headerWidget.style.display = "flex";
    
    // Garantir que fridge seja sempre um Set válido
    if (!(state.fridge instanceof Set)) {
        state.fridge = new Set(state.fridge || []);
    }
    
    // Estatísticas da trilha ativa
    const fridgeSize = state.fridge.size || 0;
    const activeCount = Math.max(0, state.questions.length - fridgeSize);
    setText("statQuestionsCount", activeCount);
    setText("statFridgeCount",    fridgeSize);
    
    const maxStreak = Math.max(activeProfile.consecutiveIntCount, activeProfile.consecutiveProfCount);
    setText("statStreakCount", maxStreak);
    setText("statBestScore",   `${activeProfile.bestScore}%`);
    
    // Habilitar ou desabilitar botão de simulado
    const btnStart = document.getElementById("btnStartSimulator");
    if (btnStart) {
        if (state.questions.length > 0) {
            btnStart.removeAttribute("disabled");
        } else {
            btnStart.setAttribute("disabled", "true");
        }
    }
    
    // Exibir Streaks da trilha
    updateStreaksUI();
    
    // Exibir Domínios de Performance (Apenas SAA-C03)
    updateDomainsUI();
    
    // Atualizar Missões no Dashboard
    renderMissionsUI();
}

function updateStreaksUI() {
    const activeProfile = state.profiles[state.activeTrack];
    const streakCard = document.getElementById("streakCard");
    if (!streakCard) return;
    streakCard.style.display = "block";
    
    let statusMsg = "";
    if (activeProfile.level === "amador") {
        statusMsg = "Seu nível é Amador na trilha ativa. Continue treinando!";
    } else if (activeProfile.level === "intermediario") {
        statusMsg = "Você é Intermediário na trilha ativa. Falta pouco para Profissional!";
    } else if (activeProfile.level === "profissional") {
        statusMsg = "🏆 Você é PROFISSIONAL na trilha ativa! Pronto para o exame!";
    }
    const streakLabel = document.getElementById("streakStatusLabel");
    if (streakLabel) streakLabel.innerText = statusMsg;
    
    // Dots Intermediário
    const intDotsEl = document.getElementById("intermediateStreakDots");
    if (intDotsEl) {
        const intDots = intDotsEl.children;
        for (let i = 0; i < intDots.length; i++) {
            intDots[i].className = "streak-dot";
            if (i < activeProfile.consecutiveIntCount) {
                intDots[i].classList.add("active-int");
            }
        }
    }
    
    // Dots Profissional
    const profDotsEl = document.getElementById("professionalStreakDots");
    if (profDotsEl) {
        const profDots = profDotsEl.children;
        for (let i = 0; i < profDots.length; i++) {
            profDots[i].className = "streak-dot";
            if (i < activeProfile.consecutiveProfCount) {
                profDots[i].classList.add("active-prof");
            }
        }
    }
}


function updateDomainsUI() {
    const domainsCard = document.getElementById("domainsCard");
    
    // Exibe apenas se a trilha ativa for Solutions Architect Associate
    if (state.activeTrack === "associate") {
        domainsCard.style.display = "block";
        
        // Calcular médias de acertos cumulativos por domínio a partir do histórico
        const activeProfile = state.profiles[state.activeTrack];
        const domStats = {
            1: { correct: 0, total: 0 },
            2: { correct: 0, total: 0 },
            3: { correct: 0, total: 0 },
            4: { correct: 0, total: 0 }
        };
        
        // Agregar dados do histórico
        activeProfile.history.forEach(sim => {
            if (sim.domains) {
                for (let d in domStats) {
                    if (sim.domains[d]) {
                        domStats[d].correct += sim.domains[d].correct || 0;
                        domStats[d].total += sim.domains[d].total || 0;
                    }
                }
            }
        });
        
        // Atualizar as barras no Dashboard
        for (let d = 1; d <= 4; d++) {
            const stats = domStats[d];
            const pctText = document.getElementById(`domainPctD${d}`);
            const fill = document.getElementById(`domainFillD${d}`);
            const rec = document.getElementById(`domainRecD${d}`);
            
            if (stats.total > 0) {
                const pct = Math.round((stats.correct / stats.total) * 100);
                pctText.innerText = `${pct}%`;
                fill.style.width = `${pct}%`;
                
                // Definir cores e recomendações
                fill.className = "domain-progress-fill";
                rec.className = "domain-recommendation";
                
                if (pct < 65) {
                    fill.classList.add("red");
                    rec.classList.add("red");
                    rec.innerText = "⚠️ Fraco. Requer foco e estudo imediato!";
                } else if (pct >= 85) {
                    fill.classList.add("green");
                    rec.classList.add("green");
                    rec.innerText = "✅ Excelente domínio! Nível ideal.";
                } else {
                    fill.classList.add("yellow");
                    rec.classList.add("yellow");
                    rec.innerText = "⚖️ Intermediário. Pratique mais simulados.";
                }
            } else {
                // Sem histórico
                pctText.innerText = "0%";
                fill.style.width = "0%";
                fill.className = "domain-progress-fill red";
                rec.className = "domain-recommendation red";
                rec.innerText = "⚠️ Sem histórico de simulados";
            }
        }
    } else {
        domainsCard.style.display = "none";
    }
}


// --- LÓGICA DE SIMULADO ---
function startTimer() {
    state.timerSeconds = 0;
    document.getElementById("timerMinutes").innerText = "00";
    document.getElementById("timerSeconds").innerText = "00";
    
    if (state.timerInterval) clearInterval(state.timerInterval);
    
    state.timerInterval = setInterval(() => {
        state.timerSeconds++;
        const minutes = Math.floor(state.timerSeconds / 60);
        const seconds = state.timerSeconds % 60;
        
        document.getElementById("timerMinutes").innerText = minutes.toString().padStart(2, '0');
        document.getElementById("timerSeconds").innerText = seconds.toString().padStart(2, '0');
    }, 1000);
}

function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
}

function generateSimulator() {
    // Garantir geladeira como Set antes de usar .has()
    if (!(state.fridge instanceof Set)) {
        state.fridge = new Set(state.fridge || []);
    }
    
    if (state.questions.length === 0) {
        alert("Nenhuma questão carregada para esta trilha. Acesse o painel Admin (⚙️) e carregue as questões primeiro.");
        return;
    }
    
    let available = state.questions.filter(q => !state.fridge.has(q.id));
    
    if (available.length < 45) {
        if (state.questions.length < 45) {
            alert(`Aviso: O banco de questões desta trilha possui apenas ${state.questions.length} questões. O simulado conterá todas elas.`);
            available = [...state.questions];
        } else {
            alert("Aviso: Menos de 45 questões ativas. Algumas questões foram retiradas temporariamente da geladeira para completar este simulado.");
            const needed = 45 - available.length;
            const fromFridge = Array.from(state.fridge);
            const shuffledFridge = fromFridge.sort(() => 0.5 - Math.random());
            for (let i = 0; i < needed && i < shuffledFridge.length; i++) {
                const qId = shuffledFridge[i];
                const qObj = state.questions.find(q => q.id === qId);
                if (qObj) available.push(qObj);
            }
        }
    }
    
    const limit = Math.min(45, available.length);
    const shuffled = available.sort(() => 0.5 - Math.random());
    state.currentQuiz = shuffled.slice(0, limit);
    
    state.currentQuestionIndex = 0;
    state.userAnswers = [];
    state.selectedOption = null;
    state.selectedConfidence = null;
    
    renderQuestion();
    startTimer();
    showSection("quizSection");
}

function renderQuestion() {
    const question = state.currentQuiz[state.currentQuestionIndex];
    
    document.getElementById("currentQuestionNumber").innerText = state.currentQuestionIndex + 1;
    document.getElementById("totalQuestionsNumber").innerText = state.currentQuiz.length;
    
    const pct = (state.currentQuestionIndex / state.currentQuiz.length) * 100;
    document.getElementById("quizProgressBar").style.width = `${pct}%`;
    
    // Tag de Domínio (AWS SAA-C03) ou Trilha Geral
    const domTag = document.getElementById("questionDomainTag");
    if (state.activeTrack === "associate" && question.domain) {
        const domainNames = {
            1: "Domínio 1: Design de Arquiteturas Seguras (30%)",
            2: "Domínio 2: Design de Arquiteturas Resilientes (26%)",
            3: "Domínio 3: Design de Arquiteturas de Alta Performance (24%)",
            4: "Domínio 4: Design de Arquiteturas Otimizadas em Custo (20%)"
        };
        domTag.style.display = "block";
        domTag.innerText = domainNames[question.domain] || `Domínio ${question.domain}`;
    } else {
        domTag.style.display = "none";
    }
    
    document.getElementById("questionText").innerText = `${state.currentQuestionIndex + 1}. ${question.text}`;
    
    const optionsContainer = document.getElementById("optionsContainer");
    optionsContainer.innerHTML = "";
    
    document.getElementById("btnVerifyAnswer").setAttribute("disabled", "true");
    document.getElementById("btnVerifyAnswer").style.display = "block";
    document.getElementById("btnNextQuestion").style.display = "none";
    
    document.querySelectorAll("#confidenceBtnGroup .confidence-btn").forEach(btn => {
        btn.classList.remove("active");
        btn.removeAttribute("disabled");
    });
    
    state.selectedConfidence = null;
    state.selectedOption = null;
    
    Object.keys(question.options).sort().forEach(letter => {
        const item = document.createElement("div");
        item.className = "option-item";
        item.setAttribute("data-option", letter);
        
        item.innerHTML = `
            <div class="option-marker">${letter}</div>
            <div class="option-content">${question.options[letter]}</div>
        `;
        
        item.addEventListener("click", () => {
            if (document.getElementById("btnVerifyAnswer").style.display !== "none") {
                document.querySelectorAll(".option-item").forEach(opt => opt.classList.remove("selected"));
                item.classList.add("selected");
                state.selectedOption = letter;
                checkVerifyButtonEnable();
            }
        });
        
        optionsContainer.appendChild(item);
    });
}

function selectConfidence(value) {
    if (document.getElementById("btnVerifyAnswer").style.display === "none") return;
    
    document.querySelectorAll("#confidenceBtnGroup .confidence-btn").forEach(btn => {
        btn.classList.remove("active");
        if (btn.getAttribute("data-value") === value) {
            btn.classList.add("active");
        }
    });
    
    state.selectedConfidence = value;
    checkVerifyButtonEnable();
}

function checkVerifyButtonEnable() {
    const btn = document.getElementById("btnVerifyAnswer");
    if (state.selectedOption && state.selectedConfidence) {
        btn.removeAttribute("disabled");
    } else {
        btn.setAttribute("disabled", "true");
    }
}

function verifyAnswer() {
    const question = state.currentQuiz[state.currentQuestionIndex];
    const correctLetter = question.answer.toUpperCase();
    const selectedLetter = state.selectedOption;
    const isCorrect = (selectedLetter === correctLetter);
    
    document.querySelectorAll("#confidenceBtnGroup .confidence-btn").forEach(btn => {
        btn.setAttribute("disabled", "true");
    });
    
    document.querySelectorAll(".option-item").forEach(item => {
        const optLetter = item.getAttribute("data-option");
        if (optLetter === correctLetter) {
            item.classList.add("correct");
        } else if (optLetter === selectedLetter && !isCorrect) {
            item.classList.add("incorrect");
        }
    });
    
    let sentToFridge = false;
    if (state.selectedConfidence === "sei" && isCorrect) {
        state.fridge.add(question.id);
        // Atualizar lista da geladeira no perfil específico
        state.profiles[state.activeTrack].fridge = Array.from(state.fridge);
        sentToFridge = true;
        state.consecutiveSeiCount = (state.consecutiveSeiCount || 0) + 1;
        saveProfileToLocalStorage();
    } else if (state.selectedConfidence === "sei" && !isCorrect) {
        state.consecutiveSeiCount = 0;
        saveProfileToLocalStorage();
    }
    
    state.userAnswers.push({
        questionId: question.id,
        selectedOption: selectedLetter,
        correctOption: correctLetter,
        correct: isCorrect,
        confidence: state.selectedConfidence,
        sentToFridge: sentToFridge,
        domain: question.domain || 1
    });
    
    document.getElementById("btnVerifyAnswer").style.display = "none";
    const btnNext = document.getElementById("btnNextQuestion");
    btnNext.style.display = "block";
    
    if (state.currentQuestionIndex === state.currentQuiz.length - 1) {
        btnNext.innerHTML = `
            Finalizar Simulado 🏁
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
        `;
    } else {
        btnNext.innerHTML = `
            Próxima Questão
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        `;
    }
}

function nextQuestion() {
    if (state.currentQuestionIndex < state.currentQuiz.length - 1) {
        state.currentQuestionIndex++;
        renderQuestion();
    } else {
        finishQuiz();
    }
}

function finishQuiz() {
    stopTimer();
    
    const activeProfile = state.profiles[state.activeTrack];
    const totalQuestions = state.currentQuiz.length;
    const correctCount = state.userAnswers.filter(ans => ans.correct).length;
    const pct = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
    
    if (pct > activeProfile.bestScore) {
        activeProfile.bestScore = pct;
    }
    
    // Agrupar respostas por domínio para salvar no histórico
    const domStats = {
        1: { correct: 0, total: 0 },
        2: { correct: 0, total: 0 },
        3: { correct: 0, total: 0 },
        4: { correct: 0, total: 0 }
    };
    
    state.userAnswers.forEach(ans => {
        const dom = ans.domain || 1;
        if (domStats[dom]) {
            domStats[dom].total++;
            if (ans.correct) domStats[dom].correct++;
        }
    });
    
    // Registrar no histórico com domínios
    const dateStr = new Date().toLocaleString("pt-BR");
    activeProfile.history.push({
        date: dateStr,
        correct: correctCount,
        total: totalQuestions,
        percentage: pct,
        timeSeconds: state.timerSeconds,
        domains: domStats
    });
    
    // --- LÓGICA DE PROMOÇÃO / REBAIXAMENTO ---
    let levelTitle = "Amador";
    let levelDesc = "";
    
    if (pct < 65) {
        activeProfile.level = "amador";
        activeProfile.consecutiveIntCount = 0;
        activeProfile.consecutiveProfCount = 0;
        
        levelTitle = "Nível: Amador 🛑";
        levelDesc = `Sua pontuação foi de ${pct}%. Ficou abaixo do mínimo de 65%. É necessário estudar mais a base teórica da trilha ativa.`;
    } else if (pct >= 75 && pct <= 84) {
        activeProfile.consecutiveIntCount++;
        activeProfile.consecutiveProfCount = 0;
        
        if (activeProfile.consecutiveIntCount >= 3) {
            activeProfile.level = "intermediario";
        }
        
        levelTitle = activeProfile.level === "intermediario" ? "Nível: Intermediário 🚀" : "Nível: Praticando... ⚖️";
        levelDesc = `Muito bom! Você atingiu ${pct}%. Sequência de acertos consecutiva: ${activeProfile.consecutiveIntCount}/3 na faixa de 75-84%.`;
    } else if (pct >= 85) {
        activeProfile.consecutiveProfCount++;
        activeProfile.consecutiveIntCount = 0;
        
        if (activeProfile.consecutiveProfCount >= 5) {
            activeProfile.level = "profissional";
        }
        
        levelTitle = activeProfile.level === "profissional" ? "Nível: PROFISSIONAL! 🏆" : "Nível: Quase lá! 🔥";
        levelDesc = `Excepcional! Nota de ${pct}%. Sequência de acertos consecutiva: ${activeProfile.consecutiveProfCount}/5 na faixa de 85%+.`;
    } else {
        // Entre 65% e 74%
        activeProfile.consecutiveIntCount = 0;
        activeProfile.consecutiveProfCount = 0;
        
        levelTitle = `Nível: ${activeProfile.level.charAt(0).toUpperCase() + activeProfile.level.slice(1)}`;
        levelDesc = `Você pontuou ${pct}%. Ficou na média, mas as sequências para evolução de perfil foram reiniciadas.`;
    }
    
    saveProfileToLocalStorage();
    
    // Checar novas missões concluídas nesse simulado
    const newlyCompleted = evaluateMissions();
    const congratsBox = document.getElementById("congratsMissionBox");
    const congratsFlex = document.getElementById("congratsBadgesFlex");
    
    if (congratsBox && congratsFlex) {
        if (newlyCompleted && newlyCompleted.length > 0) {
            congratsBox.style.display = "block";
            congratsFlex.innerHTML = "";
            newlyCompleted.forEach(db => {
                const item = document.createElement("div");
                item.className = "congrats-badge-item";
                item.innerHTML = `
                    <span class="congrats-badge-icon">${db.badge}</span>
                    <span>${db.badgeName} (${db.name})</span>
                `;
                congratsFlex.appendChild(item);
            });
        } else {
            congratsBox.style.display = "none";
        }
    }
    
    // Atualizar UI de Resultados
    document.getElementById("resultsPercentageText").innerText = `${pct}%`;
    document.getElementById("resultsFractionText").innerText = `${correctCount} de ${totalQuestions}`;
    document.getElementById("resultsLevelTitle").innerText = levelTitle;
    document.getElementById("resultsLevelDesc").innerText = levelDesc;
    
    const minutes = Math.floor(state.timerSeconds / 60).toString().padStart(2, '0');
    const seconds = (state.timerSeconds % 60).toString().padStart(2, '0');
    document.getElementById("resultsTimeText").innerText = `${minutes}:${seconds}`;
    
    const fridgeAdded = state.userAnswers.filter(ans => ans.sentToFridge).length;
    document.getElementById("resultsSentToFridgeText").innerText = fridgeAdded;
    document.getElementById("resultsKeptInPoolText").innerText = totalQuestions - fridgeAdded;
    
    const resultsBadge = document.getElementById("resultsBadgeDisplay");
    resultsBadge.className = `badge badge-${activeProfile.level}`;
    resultsBadge.innerText = activeProfile.level.charAt(0).toUpperCase() + activeProfile.level.slice(1);
    
    // Barras de Domínio de Resultados (SAA-C03)
    const resultsDomainsCard = document.getElementById("resultsDomainsCard");
    if (state.activeTrack === "associate") {
        resultsDomainsCard.style.display = "block";
        for (let d = 1; d <= 4; d++) {
            const dStat = domStats[d];
            const dPctText = document.getElementById(`resultsDomainPctD${d}`);
            const dFill = document.getElementById(`resultsDomainFillD${d}`);
            
            if (dStat.total > 0) {
                const dPct = Math.round((dStat.correct / dStat.total) * 100);
                dPctText.innerText = `${dPct}% (${dStat.correct}/${dStat.total})`;
                dFill.style.width = `${dPct}%`;
                
                dFill.className = "domain-progress-fill";
                if (dPct < 65) dFill.classList.add("red");
                else if (dPct >= 85) dFill.classList.add("green");
                else dFill.classList.add("yellow");
            } else {
                dPctText.innerText = "0% (0/0)";
                dFill.style.width = "0%";
                dFill.className = "domain-progress-fill red";
            }
        }
    } else {
        resultsDomainsCard.style.display = "none";
    }
    
    // Animação de Anel de Resultados
    const circle = document.getElementById("resultsCircleProgress");
    const radius = circle.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (pct / 100) * circumference;
    
    if (pct < 65) circle.style.stroke = "var(--color-danger)";
    else if (pct >= 85) circle.style.stroke = "var(--color-success)";
    else circle.style.stroke = "var(--color-primary)";
    
    setTimeout(() => {
        circle.style.strokeDashoffset = offset;
    }, 100);
    
    showSection("resultsSection");
}


// --- GERENCIADOR DA GELADEIRA MODAL ---
function renderFridgeItems(filterQuery = "") {
    const container = document.getElementById("fridgeContainer");
    container.innerHTML = "";
    
    const fridgeArray = Array.from(state.fridge);
    const filteredIds = fridgeArray.filter(qId => {
        const question = state.questions.find(q => q.id === qId);
        if (!question) return false;
        if (!filterQuery) return true;
        return question.text.toLowerCase().includes(filterQuery.toLowerCase());
    });
    
    if (filteredIds.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--text-muted); padding: 2rem;">
                ${filterQuery ? "Nenhuma questão correspondente encontrada." : "Geladeira vazia nesta trilha."}
            </div>
        `;
        return;
    }
    
    filteredIds.forEach(qId => {
        const question = state.questions.find(q => q.id === qId);
        if (!question) return;
        
        const item = document.createElement("div");
        item.className = "fridge-item";
        
        item.innerHTML = `
            <div class="fridge-item-text" title="${question.text}">${question.text}</div>
            <button class="btn-icon" data-id="${qId}" title="Retirar da Geladeira">
                🔥
            </button>
        `;
        
        item.querySelector(".btn-icon").addEventListener("click", () => {
            state.fridge.delete(qId);
            state.profiles[state.activeTrack].fridge = Array.from(state.fridge);
            saveProfileToLocalStorage();
            refreshState();
            renderFridgeItems(document.getElementById("fridgeSearchInput").value);
        });
        
        container.appendChild(item);
    });
}

function openFridgeModal() {
    document.getElementById("fridgeModal").classList.add("active");
    document.getElementById("fridgeSearchInput").value = "";
    renderFridgeItems();
}

function closeFridgeModal() {
    document.getElementById("fridgeModal").classList.remove("active");
}


// --- EXPORTAR / IMPORTAR PROGRESSO ---
function exportProgress() {
    const dataToSave = {
        userName: state.userName,
        profiles: {
            practitioner: {
                level: state.profiles.practitioner.level,
                consecutiveIntCount: state.profiles.practitioner.consecutiveIntCount,
                consecutiveProfCount: state.profiles.practitioner.consecutiveProfCount,
                bestScore: state.profiles.practitioner.bestScore,
                history: state.profiles.practitioner.history,
                fridge: Array.from(state.profiles.practitioner.fridge || [])
            },
            associate: {
                level: state.profiles.associate.level,
                consecutiveIntCount: state.profiles.associate.consecutiveIntCount,
                consecutiveProfCount: state.profiles.associate.consecutiveProfCount,
                bestScore: state.profiles.associate.bestScore,
                history: state.profiles.associate.history,
                fridge: Array.from(state.profiles.associate.fridge || [])
            },
            professional: {
                level: state.profiles.professional.level,
                consecutiveIntCount: state.profiles.professional.consecutiveIntCount,
                consecutiveProfCount: state.profiles.professional.consecutiveProfCount,
                bestScore: state.profiles.professional.bestScore,
                history: state.profiles.professional.history,
                fridge: Array.from(state.profiles.professional.fridge || [])
            }
        }
    };
    
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(dataToSave));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `aws_simulado_progresso_completo.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

// --- SAIR DO PERFIL (LOGOUT) ---
function logoutUser() {
    if (!confirm("Deseja sair do perfil atual? O progresso já está salvo. Outro usuário poderá acessar a aplicação.")) {
        return;
    }
    
    // Resetar apenas os dados de sessão (não apaga o histórico salvo)
    state.userName = "";
    state.adminActive = false;
    state.activeTrack = "associate";
    state.questions = [];
    state.fridge = new Set();
    state.currentQuiz = [];
    state.currentQuestionIndex = 0;
    state.userAnswers = [];
    stopTimer();
    
    state.profiles = {
        practitioner: { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: new Set() },
        associate:    { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: new Set() },
        professional: { level: "amador", consecutiveIntCount: 0, consecutiveProfCount: 0, bestScore: 0, history: [], fridge: new Set() }
    };
    state.missions = {};
    state.consecutiveSeiCount = 0;
    
    // Limpar campo de nome
    const nameInput = document.getElementById("userNameInput");
    if (nameInput) nameInput.value = "";
    
    // Ocultar widget do header e resetar admin toggle
    document.getElementById("headerUserWidget").style.display = "none";
    const toggleBtn = document.getElementById("btnAdminToggle");
    if (toggleBtn) toggleBtn.classList.remove("admin-active");
    
    showWelcomeScreen();
}


function triggerImportProgress() {
    document.getElementById("importProgressFileInput").click();
}

function importProgress(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            const imported = JSON.parse(evt.target.result);
            if (imported.userName && imported.profiles) {
                state.userName = imported.userName;
                
                ["practitioner", "associate", "professional"].forEach(track => {
                    if (imported.profiles[track]) {
                        state.profiles[track].level = imported.profiles[track].level || "amador";
                        state.profiles[track].consecutiveIntCount = imported.profiles[track].consecutiveIntCount || 0;
                        state.profiles[track].consecutiveProfCount = imported.profiles[track].consecutiveProfCount || 0;
                        state.profiles[track].bestScore = imported.profiles[track].bestScore || 0;
                        state.profiles[track].history = imported.profiles[track].history || [];
                        state.profiles[track].fridge = new Set(imported.profiles[track].fridge || []);
                    }
                });
                
                saveProfileToLocalStorage();
                refreshState();
                alert("Progresso geral importado com sucesso!");
            } else {
                alert("Erro: Arquivo JSON de backup inválido.");
            }
        } catch (err) {
            alert("Erro ao ler o arquivo JSON.");
        }
    };
    reader.readAsText(file);
}


// --- PROCESSAMENTO DE ARQUIVO TEXTO (ADMIN) ---
function handleFileUpload(file) {
    if (!file) return;
    
    const uploadTrack = document.getElementById("adminTrackSelect").value;
    const statusDiv = document.getElementById("fileUploadStatus");
    statusDiv.className = "";
    statusDiv.style.color = "var(--text-main)";
    statusDiv.innerHTML = "Processando arquivo... ⏳";
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        const parsed = parseTXTQuestions(text);
        
        if (parsed.length === 0) {
            statusDiv.style.color = "var(--color-danger)";
            statusDiv.innerHTML = "Erro: Nenhuma questão válida identificada. Verifique o formato do arquivo.";
            return;
        }
        
        clearQuestionsByTrackInDB(uploadTrack)
            .then(() => saveQuestionsToDB(parsed, uploadTrack))
            .then(() => {
                statusDiv.style.color = "var(--color-success)";
                statusDiv.innerHTML = `Sucesso! ${parsed.length} questões importadas para a trilha selecionada.`;
                
                // Atualizar estado e painéis
                refreshState();
            })
            .catch(err => {
                console.error(err);
                statusDiv.style.color = "var(--color-danger)";
                statusDiv.innerHTML = "Erro ao salvar no banco local do navegador.";
            });
    };
    reader.readAsText(file);
}


// --- EXEMPLOS DE QUESTÕES (ADMIN) ---
function loadSampleQuestions() {
    const uploadTrack = document.getElementById("adminTrackSelect").value;
    
    const sampleQuestions = [
        {
            text: "Qual serviço da AWS é ideal para armazenamento de objetos altamente escalável e durável?",
            options: {
                A: "Amazon EBS",
                B: "Amazon S3",
                C: "Amazon RDS",
                D: "Amazon EFS"
            },
            answer: "B",
            domain: 2
        },
        {
            text: "Um arquiteto de soluções precisa executar uma aplicação contêinerizada sem gerenciar servidores. Qual serviço deve ser usado?",
            options: {
                A: "Amazon EC2",
                B: "AWS Fargate",
                C: "Amazon EMR",
                D: "Amazon S3"
            },
            answer: "B",
            domain: 3
        },
        {
            text: "Qual serviço da AWS fornece entrega de conteúdo global de baixa latência e alta velocidade de transferência de dados (CDN)?",
            options: {
                A: "Amazon CloudFront",
                B: "AWS Direct Connect",
                C: "Amazon Route 53",
                D: "AWS Elastic Beanstalk"
            },
            answer: "A",
            domain: 3
        },
        {
            text: "Um banco de dados NoSQL totalmente gerenciado na AWS que oferece desempenho de milissegundo de dígito único é o:",
            options: {
                A: "Amazon RDS",
                B: "Amazon Aurora",
                C: "Amazon DynamoDB",
                D: "Amazon Redshift"
            },
            answer: "C",
            domain: 3
        },
        {
            text: "Qual ferramenta da AWS permite estimar o custo mensal dos recursos que serão implantados?",
            options: {
                A: "AWS Budgets",
                B: "AWS Pricing Calculator",
                C: "AWS Cost Explorer",
                D: "AWS Trusted Advisor"
            },
            answer: "B",
            domain: 4
        }
    ];

    clearQuestionsByTrackInDB(uploadTrack)
        .then(() => saveQuestionsToDB(sampleQuestions, uploadTrack))
        .then(() => {
            refreshState();
            alert(`5 Questões de exemplo inseridas com sucesso na trilha selecionada!`);
        })
        .catch(err => {
            console.error(err);
            alert("Erro ao salvar questões de exemplo.");
        });
}

function clearDatabaseForTrack() {
    const uploadTrack = document.getElementById("adminTrackSelect").value;
    const trackNames = {
        practitioner: "Cloud Practitioner",
        associate: "Solutions Architect Associate",
        professional: "Solutions Architect Professional"
    };
    
    if (confirm(`Aviso Crítico: Isso irá APAGAR todas as questões do banco de dados para a trilha "${trackNames[uploadTrack]}". Deseja continuar?`)) {
        clearQuestionsByTrackInDB(uploadTrack)
            .then(() => {
                refreshState();
                alert(`Banco de dados da trilha apagado!`);
            })
            .catch(err => {
                console.error(err);
                alert("Erro ao esvaziar banco de dados.");
            });
    }
}


// --- AUTENTICAÇÃO DO ADMINISTRADOR ---
function openPasswordModal() {
    document.getElementById("passwordModal").classList.add("active");
    document.getElementById("adminPasswordInput").value = "";
    document.getElementById("passwordErrorMsg").style.display = "none";
    document.getElementById("adminPasswordInput").focus();
}

function closePasswordModal() {
    document.getElementById("passwordModal").classList.remove("active");
}

function toggleAdminMode() {
    if (state.adminActive) {
        // Se já está ativo, desativa e volta ao player
        state.adminActive = false;
        document.getElementById("btnAdminToggle").classList.remove("admin-active");
        showSection("dashboardSection");
        refreshState();
    } else {
        // Abre modal pedindo senha
        openPasswordModal();
    }
}

function verifyAdminPassword() {
    const password = document.getElementById("adminPasswordInput").value;
    if (password === "admin123") {
        state.adminActive = true;
        document.getElementById("btnAdminToggle").classList.add("admin-active");
        closePasswordModal();
        showSection("adminSection");
        refreshState();
    } else {
        document.getElementById("passwordErrorMsg").style.display = "block";
    }
}


// --- FUNÇÃO AUXILIAR PARA BIND SEGURO ---
function safeBindClick(id, callback) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", callback);
}

// --- EVENT LISTENERS E INICIALIZAÇÃO ---
document.addEventListener("DOMContentLoaded", () => {
    migrateOldProfile();
    loadProfileFromLocalStorage();
    
    const playerTrackSelect = document.getElementById("playerTrackSelect");
    if (playerTrackSelect) {
        playerTrackSelect.addEventListener("change", (e) => {
            state.activeTrack = e.target.value;
            refreshState();
        });
    }
    
    let _nameInputTimer = null;
    const userNameInput = document.getElementById("userNameInput");
    if (userNameInput) {
        userNameInput.addEventListener("input", (e) => {
            const newName = e.target.value.trim();
            if (!newName) return;
            const oldName = state.userName;
            if (oldName === newName) return;
            
            clearTimeout(_nameInputTimer);
            _nameInputTimer = setTimeout(() => {
                const list = getPlayersList();
                const idx = list.indexOf(oldName);
                if (idx !== -1) {
                    list[idx] = newName;
                } else if (!list.includes(newName)) {
                    list.push(newName);
                }
                savePlayersList(list);
                
                localStorage.removeItem(PLAYER_PREFIX + oldName);
                state.userName = newName;
                saveProfileToLocalStorage();
                
                localStorage.setItem("aws_simulator_last_player", newName);
                refreshState();
            }, 800);
        });
    }
    
    safeBindClick("btnStartSimulator", () => generateSimulator());
    safeBindClick("btnOpenFridge", openFridgeModal);
    safeBindClick("btnCloseFridge", closeFridgeModal);
    safeBindClick("btnConfirmCloseFridge", closeFridgeModal);
    
    const fridgeSearch = document.getElementById("fridgeSearchInput");
    if (fridgeSearch) {
        fridgeSearch.addEventListener("input", (e) => {
            renderFridgeItems(e.target.value);
        });
    }
    
    safeBindClick("btnResetFridge", () => {
        if (confirm("Deseja remover TODAS as questões da geladeira nesta trilha ativa?")) {
            state.fridge.clear();
            state.profiles[state.activeTrack].fridge = [];
            saveProfileToLocalStorage();
            refreshState();
            closeFridgeModal();
            alert("Geladeira esvaziada!");
        }
    });
    
    safeBindClick("btnExportProgress", exportProgress);
    safeBindClick("btnImportProgress", triggerImportProgress);
    
    const importInput = document.getElementById("importProgressFileInput");
    if (importInput) {
        importInput.addEventListener("change", importProgress);
    }
    
    safeBindClick("btnLogout", logoutUser);
    
    document.querySelectorAll("#confidenceBtnGroup .confidence-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            selectConfidence(btn.getAttribute("data-value"));
        });
    });
    
    safeBindClick("btnVerifyAnswer", verifyAnswer);
    safeBindClick("btnNextQuestion", nextQuestion);
    
    safeBindClick("btnQuitQuiz", () => {
        if (confirm("Tem certeza que deseja sair? O progresso desta rodada não será salvo.")) {
            stopTimer();
            showSection("dashboardSection");
        }
    });
    
    safeBindClick("btnRestartQuiz", generateSimulator);
    safeBindClick("btnBackToDashboard", () => {
        showSection("dashboardSection");
        refreshState();
    });
    
    safeBindClick("btnAdminToggle", toggleAdminMode);
    safeBindClick("btnExitAdmin", () => {
        state.adminActive = false;
        const toggleBtn = document.getElementById("btnAdminToggle");
        if (toggleBtn) toggleBtn.classList.remove("admin-active");
        showSection("dashboardSection");
        refreshState();
    });
    
    const dropArea = document.getElementById("dropArea");
    const fileInput = document.getElementById("fileInput");
    if (dropArea && fileInput) {
        dropArea.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", (e) => handleFileUpload(e.target.files[0]));
        
        dropArea.addEventListener("dragover", (e) => {
            e.preventDefault();
            dropArea.classList.add("dragover");
        });
        dropArea.addEventListener("dragleave", () => {
            dropArea.classList.remove("dragover");
        });
        dropArea.addEventListener("drop", (e) => {
            e.preventDefault();
            dropArea.classList.remove("dragover");
            if (e.dataTransfer.files.length > 0) {
                handleFileUpload(e.dataTransfer.files[0]);
            }
        });
    }
    
    safeBindClick("btnAdminLoadSample", loadSampleQuestions);
    safeBindClick("btnAdminClearDB", clearDatabaseForTrack);
    
    safeBindClick("btnClosePasswordModal", closePasswordModal);
    safeBindClick("btnCancelPasswordModal", closePasswordModal);
    safeBindClick("btnSubmitPasswordModal", verifyAdminPassword);
    
    const adminPassInput = document.getElementById("adminPasswordInput");
    if (adminPassInput) {
        adminPassInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                verifyAdminPassword();
            }
        });
    }
    
    safeBindClick("btnShowCreatePlayerModal", openNewPlayerModal);
    safeBindClick("btnCloseNewPlayerModal", closeNewPlayerModal);
    safeBindClick("btnCancelNewPlayerModal", closeNewPlayerModal);
    safeBindClick("btnSubmitNewPlayerModal", submitCreatePlayer);
    
    const newPlayerInput = document.getElementById("newPlayerNameInput");
    if (newPlayerInput) {
        newPlayerInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                submitCreatePlayer();
            }
        });
    }
});
