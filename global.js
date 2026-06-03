// global.js - Include this in all HTML files
// Add this line after your existing scripts: <script src="global.js"></script>

(function() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGlobalFeatures);
    } else {
        initGlobalFeatures();
    }

    let currentUser = null;
    let announcementAudio = null;   // Audio element for LIS.mp3
    let audioEnabled = false;       // Prevents playing on initial load
    let lastSeenTimestamp = 0;

    async function initGlobalFeatures() {
        // Get current user from session
        try {
            const raw = sessionStorage.getItem('muujiza_session');
            if (raw) {
                currentUser = JSON.parse(raw);
            }
        } catch(e) {
            console.error('Failed to get session:', e);
        }

        if (!currentUser) return;

        // Add global UI elements to the page
        addGlobalUI();
        
        // Load announcements (does NOT play sound)
        await loadAnnouncements();
        
        // Setup realtime subscription
        setupRealtimeSubscription();
        
        // Setup sample search
        setupSampleSearch();

        // Preload announcement audio but do NOT play yet
        setupAnnouncementAudio();

        // Enable audio only after 1 second (prevents initial subscription events)
        setTimeout(() => { audioEnabled = true; }, 1000);
    }

    // ========== ANNOUNCEMENT SOUND (LIS.mp3) ==========
    function setupAnnouncementAudio() {
        announcementAudio = new Audio('LIS.mp3');
        announcementAudio.preload = 'auto';
        announcementAudio.load();
        // No autoplay tricks needed — sound is triggered by the send button click (a real user gesture)
    }

    function playAnnouncementSound() {
        if (!announcementAudio) return;
        announcementAudio.currentTime = 0;
        announcementAudio.play().catch(err => console.warn('Audio play failed:', err));
    }

    // ========== EXISTING FUNCTIONS (with sound added to realtime) ==========
    function addGlobalUI() {
        // Check if already added
        if (document.getElementById('globalNotificationPanel')) return;

        // Create notification panel
        const panel = document.createElement('div');
        panel.id = 'globalNotificationPanel';
        panel.className = 'global-notification-panel';
        panel.innerHTML = `
            <div class="notification-header" id="notificationHeader">
                <span><i class="fas fa-comment-dots"></i> Lab Announcements <span id="unreadCount" class="unread-badge" style="display:none;">0</span></span>
                <i class="fas fa-chevron-up"></i>
            </div>
            <div class="notification-content" id="notificationContent">
                <div id="announcementsList" style="max-height:300px; overflow-y:auto;">
                    <div style="text-align:center; padding:20px; color:var(--muted);">Loading announcements...</div>
                </div>
                <div class="send-message-form">
                    <input type="text" id="announcementInput" placeholder="Send announcement to everyone..." maxlength="200">
                    <button id="sendAnnouncementBtn"><i class="fas fa-paper-plane"></i> Send</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        // Create sample search widget
        const searchWidget = document.createElement('div');
        searchWidget.id = 'globalSampleSearch';
        searchWidget.className = 'global-sample-search';
        searchWidget.innerHTML = `
            <div class="search-container">
                <i class="fas fa-search" style="color:var(--muted);"></i>
                <input type="text" id="globalSampleSearchInput" placeholder="Track sample by ID (e.g., MU-123)...">
                <button id="globalSampleSearchBtn"><i class="fas fa-arrow-right"></i></button>
            </div>
            <div class="search-results-dropdown" id="searchResultsDropdown"></div>
        `;
        document.body.appendChild(searchWidget);

        // Store searchWidget reference for later use
        window._searchWidget = searchWidget;

        // Toggle collapsible
        const header = document.getElementById('notificationHeader');
        const content = document.getElementById('notificationContent');
        let isCollapsed = false;
        
        if (header && content) {
            header.addEventListener('click', () => {
                isCollapsed = !isCollapsed;
                content.style.display = isCollapsed ? 'none' : 'block';
                header.classList.toggle('collapsed', isCollapsed);
            });
        }

        // Send announcement
        const sendBtn = document.getElementById('sendAnnouncementBtn');
        const input = document.getElementById('announcementInput');
        
        if (sendBtn && input) {
            sendBtn.addEventListener('click', () => sendAnnouncement());
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') sendAnnouncement();
            });
        }
    }

    async function sendAnnouncement() {
        const input = document.getElementById('announcementInput');
        if (!input) return;
        
        const message = input.value.trim();
        if (!message) return;

        try {
            const client = getSupabaseClient();
            if (!client) {
                console.error('Supabase client not available');
                return;
            }

            const { error } = await client
                .from('announcements')
                .insert([{
                    message: message,
                    sender_name: currentUser?.name || 'Staff',
                    sender_role: currentUser?.role || 'staff',
                    created_at: new Date().toISOString(),
                    expires_at: new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString(), // 30 hours
                    is_pinned: false
                }]);

            if (error) throw error;
            input.value = '';

            // Play sound — this runs inside a click handler so browser allows it
            playAnnouncementSound();
            
            // Show temporary confirmation
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed; bottom:100px; right:20px; background:var(--primary); color:white; padding:8px 16px; border-radius:20px; font-size:0.75rem; z-index:1001;';
            toast.innerHTML = '<i class="fas fa-check"></i> Announcement sent!';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2000);
            
        } catch(err) {
            console.error('Send failed:', err);
        }
    }

    async function loadAnnouncements() {
        try {
            const client = getSupabaseClient();
            if (!client) {
                console.error('Supabase client not available');
                return;
            }

            const { data, error } = await client
                .from('announcements')
                .select('*')
                .or(`expires_at.gt.${new Date().toISOString()},expires_at.is.null`)
                .order('is_pinned', { ascending: false })
                .order('created_at', { ascending: false })
                .limit(20);

            if (error) throw error;
            renderAnnouncements(data || []);
            
            // Update unread count
            const lastSeen = localStorage.getItem('lastSeenAnnouncement') || 0;
            const unreadCount = (data || []).filter(a => new Date(a.created_at).getTime() > parseInt(lastSeen)).length;
            const unreadBadge = document.getElementById('unreadCount');
            if (unreadBadge) {
                if (unreadCount > 0) {
                    unreadBadge.style.display = 'inline-block';
                    unreadBadge.textContent = unreadCount;
                } else {
                    unreadBadge.style.display = 'none';
                }
            }
            
        } catch(err) {
            console.error('Load announcements failed:', err);
        }
    }

    function renderAnnouncements(announcements) {
        const container = document.getElementById('announcementsList');
        if (!container) return;
        
        if (!announcements.length) {
            container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);"><i class="fas fa-comment-slash"></i> No announcements</div>';
            return;
        }
        
        container.innerHTML = announcements.map(a => `
            <div class="notification-message ${a.is_pinned ? 'pinned' : ''}">
                <div class="message-text">${escapeHtml(a.message)}</div>
                <div class="message-meta">
                    <span><i class="fas fa-user"></i> ${escapeHtml(a.sender_name)} (${escapeHtml(a.sender_role)})</span>
                    <span><i class="fas fa-clock"></i> ${formatTimeAgo(new Date(a.created_at))}</span>
                </div>
            </div>
        `).join('');
        
        // Mark as seen
        if (announcements.length > 0) {
            const latestTime = Math.max(...announcements.map(a => new Date(a.created_at).getTime()));
            localStorage.setItem('lastSeenAnnouncement', latestTime.toString());
            const unreadBadge = document.getElementById('unreadCount');
            if (unreadBadge) unreadBadge.style.display = 'none';
        }
    }

    function setupRealtimeSubscription() {
        const client = getSupabaseClient();
        if (!client) return;

        // Store last seen timestamp to avoid replaying old announcements
        let lastSeen = parseInt(localStorage.getItem('lastSeenAnnouncement') || '0');

        const channel = client
            .channel('announcements-channel')
            .on('postgres_changes', 
                { event: 'INSERT', schema: 'public', table: 'announcements' },
                (payload) => {
                    const newTime = new Date(payload.new?.created_at).getTime();
                    // Only process if it's truly newer than last seen AND audio is enabled (page loaded)
                    if (newTime > lastSeen && audioEnabled) {
                        // Refresh announcements list
                        loadAnnouncements();
                        // Play sound for new announcement
                        playAnnouncementSound();

                        // Request browser notification permission if not already
                        if (Notification.permission === 'granted') {
                            new Notification('📢 New Lab Announcement', {
                                body: payload.new?.message || 'Check the announcements panel',
                                icon: '/favicon.ico'
                            });
                        } else if (Notification.permission !== 'denied') {
                            Notification.requestPermission();
                        }
                        
                        // Update lastSeen locally to avoid double play for same announcement
                        lastSeen = newTime;
                    }
                }
            )
            .subscribe();
    }

    function setupSampleSearch() {
        const searchInput = document.getElementById('globalSampleSearchInput');
        const searchBtn = document.getElementById('globalSampleSearchBtn');
        const dropdown = document.getElementById('searchResultsDropdown');
        
        if (!searchInput || !searchBtn || !dropdown) return;
        
        let debounceTimer;
        
        async function performSearch() {
            let query = searchInput.value.trim().replace(/MU-?/i, '');
            if (!query) {
                dropdown.classList.remove('show');
                return;
            }
            
            try {
                const client = getSupabaseClient();
                if (!client) {
                    console.error('Supabase client not available');
                    return;
                }

                const { data, error } = await client
                    .from('samples')
                    .select('id, patient, status, released_at')
                    .eq('id', parseInt(query))
                    .limit(5);
                    
                if (error) throw error;
                
                if (!data || data.length === 0) {
                    dropdown.innerHTML = '<div class="search-result-item" style="color:var(--muted);">No sample found</div>';
                    dropdown.classList.add('show');
                    return;
                }
                
                dropdown.innerHTML = data.map(s => {
                    let statusBadge;
                    if (s.status === 'Rejected') {
                        statusBadge = `<span style="display:inline-block;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;border-radius:20px;padding:1px 8px;font-size:0.68rem;font-weight:700;">✖ Rejected</span>`;
                    } else if (s.status === 'Result Released') {
                        statusBadge = `<span style="display:inline-block;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:20px;padding:1px 8px;font-size:0.68rem;font-weight:700;">✓ ${escapeHtml(s.status)}</span>`;
                    } else {
                        statusBadge = `<span style="display:inline-block;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;border-radius:20px;padding:1px 8px;font-size:0.68rem;font-weight:600;">⏳ ${escapeHtml(s.status)}</span>`;
                    }
                    return `
                    <div class="search-result-item" onclick="viewSampleDetails(${s.id})">
                        <div class="sample-id">MU-${s.id}</div>
                        <div class="sample-patient">${escapeHtml(s.patient)}</div>
                        <div style="margin-top:3px;">${statusBadge}</div>
                        ${s.status === 'Rejected' && s.rejection_reason ? `<div style="font-size:0.68rem;color:#b91c1c;margin-top:2px;"><i class="fas fa-info-circle"></i> ${escapeHtml(s.rejection_reason)}</div>` : ''}
                    </div>`;
                }).join('');
                dropdown.classList.add('show');
                
            } catch(err) {
                console.error('Search failed:', err);
            }
        }
        
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(performSearch, 500);
        });
        
        searchBtn.addEventListener('click', performSearch);
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') performSearch();
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const searchWidget = document.getElementById('globalSampleSearch');
            if (searchWidget && !searchWidget.contains(e.target)) {
                dropdown.classList.remove('show');
            }
        });
    }

    // Helper to get Supabase client from window
    function getSupabaseClient() {
        // Try multiple possible variable names
        if (window._supabaseClient) return window._supabaseClient;
        if (window.db) return window.db;
        if (window.supabase && window.supabase.from) return window.supabase;
        if (window.supabaseService) return window.supabaseService;
        
        // Create client if needed (but avoid if already exists)
        if (typeof window.buildAuthClient === 'function') {
            const SUPABASE_URL = 'https://npdopywxemtwzvpummsn.supabase.co';
            const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';
            window._supabaseClient = window.buildAuthClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            return window._supabaseClient;
        }
        
        return null;
    }

    window.viewSampleDetails = function(sampleId) {
        // Redirect to appropriate page based on user role
        let targetPage = '';
        if (currentUser && currentUser.role === 'technologist') {
            targetPage = 'result_entry.html';
        } else if (currentUser && (currentUser.role === 'supervisor' || currentUser.role === 'admin')) {
            targetPage = 'management1.html';
        } else if (currentUser && currentUser.role === 'reception') {
            targetPage = 'accession.html';
        } else {
            targetPage = 'pending_portal.html';
        }
        
        // Store sample ID to load on target page
        sessionStorage.setItem('quickViewSampleId', sampleId);
        window.location.href = targetPage;
    };

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    function formatTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }

    // Sample Timeline function
    window.viewSampleTimeline = async function(sampleId) {
        try {
            const client = getSupabaseClient();
            if (!client) {
                console.error('Supabase client not available');
                return;
            }

            const { data, error } = await client
                .from('sample_timeline')
                .select('*')
                .eq('sample_id', sampleId)
                .order('created_at', { ascending: true });
                
            if (error) throw error;
            
            showTimelineModal(sampleId, data || []);
        } catch(err) {
            console.error('Failed to load timeline:', err);
        }
    };

    function showTimelineModal(sampleId, events) {
        // Create modal if not exists
        let modal = document.getElementById('timelineModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'timelineModal';
            modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:none; align-items:center; justify-content:center; z-index:2000;';
            modal.innerHTML = `
                <div style="background:white; border-radius:20px; max-width:500px; width:90%; max-height:80vh; overflow-y:auto; padding:20px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                        <h3 style="color:var(--primary);">Sample MU-${sampleId} Timeline</h3>
                        <button onclick="document.getElementById('timelineModal').style.display='none'" style="background:none; border:none; font-size:1.2rem; cursor:pointer;">✕</button>
                    </div>
                    <div id="timelineEventsList"></div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        
        const listDiv = document.getElementById('timelineEventsList');
        if (!events || events.length === 0) {
            listDiv.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted);">No events recorded yet</div>';
        } else {
            listDiv.innerHTML = events.map(e => `
                <div style="padding:12px; border-bottom:1px solid var(--border);">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                        <i class="fas fa-circle" style="font-size:0.5rem; color:var(--primary);"></i>
                        <strong>${escapeHtml(e.event_type)}</strong>
                        <span style="font-size:0.7rem; color:var(--muted); margin-left:auto;">${new Date(e.created_at).toLocaleString()}</span>
                    </div>
                    <div style="font-size:0.8rem;">${escapeHtml(e.event_description || '')}</div>
                    <div style="font-size:0.7rem; color:var(--muted);"><i class="fas fa-user"></i> ${escapeHtml(e.performed_by || 'System')} (${escapeHtml(e.performed_role || '')})</div>
                </div>
            `).join('');
        }
        
        modal.style.display = 'flex';
    }

    // Auto-load sample if coming from search
    function checkForQuickView() {
        const sampleId = sessionStorage.getItem('quickViewSampleId');
        if (sampleId) {
            sessionStorage.removeItem('quickViewSampleId');
            // Small delay to ensure page is fully loaded
            setTimeout(() => {
                if (typeof openResultModal === 'function') {
                    openResultModal(parseInt(sampleId));
                } else if (typeof openVerifyModal === 'function') {
                    openVerifyModal(parseInt(sampleId));
                } else {
                    // Fallback: redirect to management1
                    window.location.href = 'management1.html?sample=' + sampleId;
                }
            }, 500);
        }
    }

    // Call checkForQuickView after page loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkForQuickView);
    } else {
        checkForQuickView();
    }
})();