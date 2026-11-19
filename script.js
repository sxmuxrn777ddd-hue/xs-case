const socket = io();

const multiplierDisplay = document.getElementById('multiplier');
const statusText = document.getElementById('statusText');
const actionBtn = document.getElementById('actionBtn');
const betAmountInput = document.getElementById('betAmount');
const gameScreen = document.getElementById('gameScreen');

let isPlaying = false;
let hasBet = false;

// Serverdan koeffitsient yangilanganda
socket.on('multiplier_update', (data) => {
    multiplierDisplay.innerText = data.multiplier.toFixed(2) + 'x';
    multiplierDisplay.className = "text-6xl font-black text-blue-400 glow";
    statusText.innerText = "O'yin bormoqda...";
    statusText.className = "text-xs text-blue-400 mt-2 uppercase tracking-widest font-bold animate-pulse";
    
    if (hasBet && !isPlaying) {
        actionBtn.innerText = "Pulni olish (CASH OUT)";
        actionBtn.className = "w-full bg-green-600 hover:bg-green-500 text-white font-extrabold py-4 rounded-xl shadow-lg shadow-green-600/30 transition-all uppercase tracking-wider";
        isPlaying = true;
    }
});

// O'yin crash (portlaganda)
socket.on('game_crashed', (data) => {
    multiplierDisplay.innerText = `CRASHED (${data.multiplier}x)`;
    multiplierDisplay.className = "text-4xl font-black text-red-500";
    statusText.innerText = "Portlab ketdi!";
    statusText.className = "text-xs text-red-500 mt-2 uppercase tracking-widest font-bold";
    
    gameScreen.classList.add('crash-anim');
    setTimeout(() => gameScreen.classList.remove('crash-anim'), 500);

    actionBtn.innerText = "Kutilyapti...";
    actionBtn.className = "w-full bg-slate-700 text-slate-400 font-extrabold py-4 rounded-xl cursor-not-allowed uppercase tracking-wider";
    
    isPlaying = false;
    hasBet = false;
});

// Keyingi raund kutilayotganda
socket.on('game_waiting', (data) => {
    multiplierDisplay.innerText = "1.00x";
    multiplierDisplay.className = "text-5xl font-black text-slate-400";
    statusText.innerText = `Keyingi raund boshlanishiga: ${data.countdown || 5}s`;
    statusText.className = "text-xs text-slate-400 mt-2 uppercase tracking-widest font-semibold";

    actionBtn.innerText = "Stavka tikish";
    actionBtn.className = "w-full bg-blue-600 hover:bg-blue-500 text-white font-extrabold py-4 rounded-xl shadow-lg shadow-blue-600/30 transition-all uppercase tracking-wider";
});

// Tugma bosilganda
actionBtn.addEventListener('click', () => {
    const amount = parseInt(betAmountInput.value) || 100;

    if (!hasBet && statusText.innerText.includes("Kutish")) {
        hasBet = true;
        socket.emit('place_bet', { amount });
        actionBtn.innerText = "Stavka qabul qilindi ✅";
        actionBtn.className = "w-full bg-yellow-600 text-white font-extrabold py-4 rounded-xl uppercase tracking-wider cursor-default";
    } else if (isPlaying) {
        socket.emit('cash_out', { betAmount: amount });
        isPlaying = false;
        actionBtn.innerText = "Muvaffaqiyatli olindi! 💰";
        actionBtn.className = "w-full bg-slate-700 text-slate-300 font-extrabold py-4 rounded-xl uppercase tracking-wider";
    }
});