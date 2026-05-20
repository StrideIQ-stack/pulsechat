import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "./pulsechat-supabase-config.js";

const supabase = isSupabaseConfigured()
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

const authTitle = document.getElementById("authTitle");
const authStatusPill = document.getElementById("authStatusPill");
const signedOutView = document.getElementById("signedOutView");
const signedInView = document.getElementById("signedInView");
const googleSignInBtn = document.getElementById("googleSignInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const enableNotificationsBtn = document.getElementById("enableNotificationsBtn");
const notificationStatus = document.getElementById("notificationStatus");
const authError = document.getElementById("authError");
const accountAvatar = document.getElementById("accountAvatar");
const accountName = document.getElementById("accountName");
const accountEmail = document.getElementById("accountEmail");
const profileForm = document.getElementById("profileForm");
const displayNameInput = document.getElementById("displayNameInput");
const handleInput = document.getElementById("handleInput");
const profileStatus = document.getElementById("profileStatus");
const friendRequestForm = document.getElementById("friendRequestForm");
const friendHandleInput = document.getElementById("friendHandleInput");
const friendRequestStatus = document.getElementById("friendRequestStatus");
const groupForm = document.getElementById("groupForm");
const groupNameInput = document.getElementById("groupNameInput");
const groupMembersInput = document.getElementById("groupMembersInput");
const groupStatus = document.getElementById("groupStatus");
const requestCountLabel = document.getElementById("requestCountLabel");
const requestList = document.getElementById("requestList");
const friendCountLabel = document.getElementById("friendCountLabel");
const friendsList = document.getElementById("friendsList");
const groupCountLabel = document.getElementById("groupCountLabel");
const groupsList = document.getElementById("groupsList");
const chatTitle = document.getElementById("chatTitle");
const chatPresence = document.getElementById("chatPresence");
const chatMessages = document.getElementById("chatMessages");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const sendMessageBtn = document.getElementById("sendMessageBtn");

let currentSession = null;
let currentProfile = null;
let activeConversationType = "friend";
let activeFriendship = null;
let activeFriendProfile = null;
let activeGroup = null;
let requestsChannel = null;
let friendshipsChannelA = null;
let friendshipsChannelB = null;
let messagesChannel = null;
let groupsChannel = null;
let groupMessagesChannel = null;
let allMessagesChannel = null;
let allGroupMessagesChannel = null;
let friendsCache = [];
let groupsCache = [];

disableChat();
setConfigWarningIfNeeded();

googleSignInBtn.addEventListener("click", handleGoogleSignIn);
signOutBtn.addEventListener("click", handleSignOut);
enableNotificationsBtn.addEventListener("click", handleEnableNotifications);
profileForm.addEventListener("submit", handleProfileSave);
friendRequestForm.addEventListener("submit", handleFriendRequest);
groupForm.addEventListener("submit", handleCreateGroup);
messageForm.addEventListener("submit", handleSendMessage);
messageInput.addEventListener("input", autoSizeComposer);

init();

async function init() {
  if (!supabase) {
    renderSignedOut();
    renderRequests([]);
    renderFriends([]);
    renderGroups([]);
    renderEmptyChat("Connect Supabase first", "Add your Supabase URL and key, then reload this page.");
    return;
  }

  const { data } = await supabase.auth.getSession();
  await applySession(data.session);

  supabase.auth.onAuthStateChange(async (_event, session) => {
    await applySession(session);
  });
}

async function applySession(session) {
  resetRealtimeSubscriptions();
  currentSession = session;
  currentProfile = null;
  activeConversationType = "friend";
  activeFriendship = null;
  activeFriendProfile = null;
  activeGroup = null;
  friendsCache = [];
  groupsCache = [];

  if (!session?.user) {
    renderSignedOut();
    renderRequests([]);
    renderFriends([]);
    renderGroups([]);
    renderEmptyChat("Sign in and pick a friend", "Once a friend request is accepted, your conversation appears here and updates in real time.");
    return;
  }

  renderSignedIn(session.user);
  await ensureProfile(session.user);
  await refreshOwnProfile();
  await refreshRequests();
  await refreshFriendships();
  await refreshGroups();
  subscribeToRequests();
  subscribeToFriendships();
  subscribeToGroups();
  subscribeToAllMessageChanges();
  updateNotificationButton();
}

async function handleGoogleSignIn() {
  if (!supabase) {
    showStatus(authError, "Add your Supabase config first.", true);
    return;
  }

  hideStatus(authError);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + window.location.pathname
    }
  });

  if (error) {
    showStatus(authError, friendlyError(error), true);
  }
}

async function handleSignOut() {
  if (!supabase) {
    return;
  }

  await supabase.auth.signOut();
}

async function handleEnableNotifications() {
  if (!currentSession?.access_token) {
    showStatus(notificationStatus, "Sign in before enabling notifications.", true);
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    showStatus(notificationStatus, "This browser does not support push notifications.", true);
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showStatus(notificationStatus, "Notifications were not allowed.", true);
    updateNotificationButton();
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register("./service-worker.js");
    const publicKeyResponse = await fetch("/api/vapid-public-key");
    if (!publicKeyResponse.ok) {
      throw new Error("Notification API is not deployed yet. Deploy to Vercel, then try again.");
    }

    const { publicKey } = await publicKeyResponse.json();

    if (!publicKey) {
      showStatus(notificationStatus, "Add VAPID_PUBLIC_KEY in Vercel first.", true);
      return;
    }

    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    const saveResponse = await fetch("/api/push-subscribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${currentSession.access_token}`
      },
      body: JSON.stringify({ subscription })
    });

    if (!saveResponse.ok) {
      throw new Error("Subscription could not be saved.");
    }

    showStatus(notificationStatus, "Notifications enabled.");
    enableNotificationsBtn.textContent = "Notifications on";
  } catch (error) {
    showStatus(notificationStatus, error.message || "Notifications could not be enabled.", true);
    updateNotificationButton();
  }
}

async function ensureProfile(user) {
  const baseProfile = {
    id: user.id,
    email: user.email || "",
    display_name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0] || "New user",
    avatar_url: user.user_metadata?.avatar_url || "",
    updated_at: new Date().toISOString()
  };

  const { data: existing } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (!existing) {
    await supabase.from("profiles").insert({
      ...baseProfile,
      handle: "",
      handle_lower: "",
      created_at: new Date().toISOString()
    });
  } else {
    await supabase
      .from("profiles")
      .update({
        email: baseProfile.email,
        display_name: existing.display_name || baseProfile.display_name,
        avatar_url: existing.avatar_url || baseProfile.avatar_url,
        updated_at: new Date().toISOString()
      })
      .eq("id", user.id);
  }
}

async function refreshOwnProfile() {
  const user = currentSession?.user;
  if (!user) {
    return;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error) {
    showStatus(authError, friendlyError(error), true);
    return;
  }

  currentProfile = data;
  displayNameInput.value = currentProfile.display_name || "";
  handleInput.value = currentProfile.handle || "";
}

async function handleProfileSave(event) {
  event.preventDefault();
  if (!currentSession?.user) {
    showStatus(profileStatus, "Sign in first.", true);
    return;
  }

  const displayName = displayNameInput.value.trim();
  const handleLower = normalizeHandle(handleInput.value);

  if (!displayName) {
    showStatus(profileStatus, "Add a display name.", true);
    return;
  }

  if (!handleLower) {
    showStatus(profileStatus, "Add a handle using letters, numbers, or underscore.", true);
    return;
  }

  const { data: existingHandle } = await supabase
    .from("profiles")
    .select("id")
    .eq("handle_lower", handleLower)
    .neq("id", currentSession.user.id)
    .maybeSingle();

  if (existingHandle) {
    showStatus(profileStatus, "That handle is already taken.", true);
    return;
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: displayName,
      handle: handleLower,
      handle_lower: handleLower,
      updated_at: new Date().toISOString()
    })
    .eq("id", currentSession.user.id);

  if (error) {
    showStatus(profileStatus, friendlyError(error), true);
    return;
  }

  await refreshOwnProfile();
  showStatus(profileStatus, "Profile updated. Friends can now search your handle.");
}

async function handleFriendRequest(event) {
  event.preventDefault();
  if (!currentSession?.user || !currentProfile?.handle_lower) {
    showStatus(friendRequestStatus, "Save your own handle first.", true);
    return;
  }

  const targetHandle = normalizeHandle(friendHandleInput.value);
  if (!targetHandle) {
    showStatus(friendRequestStatus, "Enter a valid friend handle.", true);
    return;
  }

  const { data: targetProfile, error: targetError } = await supabase
    .from("profiles")
    .select("*")
    .eq("handle_lower", targetHandle)
    .maybeSingle();

  if (targetError || !targetProfile) {
    showStatus(friendRequestStatus, "No user found with that handle.", true);
    return;
  }

  if (targetProfile.id === currentSession.user.id) {
    showStatus(friendRequestStatus, "You cannot add yourself.", true);
    return;
  }

  const [userA, userB] = normalizePair(currentSession.user.id, targetProfile.id);
  const { data: existingFriendship } = await supabase
    .from("friendships")
    .select("id")
    .eq("user_a", userA)
    .eq("user_b", userB)
    .maybeSingle();

  if (existingFriendship) {
    showStatus(friendRequestStatus, "You are already friends.", true);
    return;
  }

  const { data: reverseRequest } = await supabase
    .from("friend_requests")
    .select("*")
    .eq("from_user", targetProfile.id)
    .eq("to_user", currentSession.user.id)
    .eq("status", "pending")
    .maybeSingle();

  if (reverseRequest) {
    await acceptRequest(reverseRequest.id, reverseRequest.from_user, reverseRequest.to_user);
    friendRequestForm.reset();
    showStatus(friendRequestStatus, "They had already requested you, so you are now friends.");
    return;
  }

  const { data: existingRequest } = await supabase
    .from("friend_requests")
    .select("id")
    .eq("from_user", currentSession.user.id)
    .eq("to_user", targetProfile.id)
    .eq("status", "pending")
    .maybeSingle();

  if (existingRequest) {
    showStatus(friendRequestStatus, "Friend request already sent.", true);
    return;
  }

  const { error } = await supabase.from("friend_requests").insert({
    from_user: currentSession.user.id,
    to_user: targetProfile.id,
    status: "pending"
  });

  if (error) {
    showStatus(friendRequestStatus, friendlyError(error), true);
    return;
  }

  friendRequestForm.reset();
  showStatus(friendRequestStatus, `Friend request sent to @${targetHandle}.`);
}

async function handleCreateGroup(event) {
  event.preventDefault();
  if (!currentSession?.user || !currentProfile?.handle_lower) {
    showStatus(groupStatus, "Save your profile before creating a group.", true);
    return;
  }

  const name = groupNameInput.value.trim();
  const handles = [...new Set(groupMembersInput.value
    .split(/[,\s]+/)
    .map(normalizeHandle)
    .filter(Boolean)
    .filter((handle) => handle !== currentProfile.handle_lower))];

  if (!name) {
    showStatus(groupStatus, "Add a group name.", true);
    return;
  }

  if (!handles.length) {
    showStatus(groupStatus, "Add at least one member handle.", true);
    return;
  }

  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id, display_name, handle, handle_lower, avatar_url")
    .in("handle_lower", handles);

  if (profileError) {
    showStatus(groupStatus, friendlyError(profileError), true);
    return;
  }

  const foundHandles = new Set((profiles || []).map((profile) => profile.handle_lower));
  const missingHandles = handles.filter((handle) => !foundHandles.has(handle));
  if (missingHandles.length) {
    showStatus(groupStatus, `No user found for @${missingHandles[0]}.`, true);
    return;
  }

  const timestamp = new Date().toISOString();
  const { data: group, error: groupError } = await supabase
    .from("groups")
    .insert({
      name,
      owner_id: currentSession.user.id,
      member_count: profiles.length + 1,
      last_message: "",
      created_at: timestamp,
      updated_at: timestamp
    })
    .select("*")
    .single();

  if (groupError) {
    showStatus(groupStatus, friendlyError(groupError), true);
    return;
  }

  const memberships = [
    {
      group_id: group.id,
      user_id: currentSession.user.id,
      role: "owner",
      joined_at: timestamp
    },
    ...(profiles || []).map((profile) => ({
      group_id: group.id,
      user_id: profile.id,
      role: "member",
      joined_at: timestamp
    }))
  ];

  const { error: memberError } = await supabase.from("group_members").insert(memberships);
  if (memberError) {
    showStatus(groupStatus, friendlyError(memberError), true);
    return;
  }

  groupForm.reset();
  await refreshGroups();
  showStatus(groupStatus, `${name} created with ${memberships.length} members.`);
}

async function refreshRequests() {
  const user = currentSession?.user;
  if (!user) {
    renderRequests([]);
    return;
  }

  const { data: requests, error } = await supabase
    .from("friend_requests")
    .select("*")
    .eq("to_user", user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    renderRequests([]);
    return;
  }

  if (!requests.length) {
    renderRequests([]);
    return;
  }

  const senderIds = requests.map((request) => request.from_user);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, handle, avatar_url")
    .in("id", senderIds);

  const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
  renderRequests(requests.map((request) => ({
    ...request,
    fromProfile: profileMap.get(request.from_user)
  })));
}

async function refreshFriendships() {
  const user = currentSession?.user;
  if (!user) {
    renderFriends([]);
    return;
  }

  const [{ data: fromA }, { data: fromB }] = await Promise.all([
    supabase.from("friendships").select("*").eq("user_a", user.id),
    supabase.from("friendships").select("*").eq("user_b", user.id)
  ]);

  const friendships = [...(fromA || []), ...(fromB || [])].sort((left, right) =>
    new Date(right.updated_at || 0) - new Date(left.updated_at || 0)
  );

  if (!friendships.length) {
    friendsCache = [];
    renderFriends([]);
    return;
  }

  const friendIds = friendships.map((friendship) =>
    friendship.user_a === user.id ? friendship.user_b : friendship.user_a
  );

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, handle, avatar_url")
    .in("id", friendIds);

  const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
  friendsCache = friendships.map((friendship) => {
    const friendId = friendship.user_a === user.id ? friendship.user_b : friendship.user_a;
    return {
      ...friendship,
      friendProfile: profileMap.get(friendId)
    };
  });

  renderFriends(friendsCache);

  if (activeFriendship) {
    const refreshed = friendsCache.find((entry) => entry.id === activeFriendship.id);
    if (refreshed) {
      activeFriendship = refreshed;
      activeFriendProfile = refreshed.friendProfile;
      renderChatHeader();
    }
  }
}

async function refreshGroups() {
  const user = currentSession?.user;
  if (!user) {
    groupsCache = [];
    renderGroups([]);
    return;
  }

  const { data: memberships, error } = await supabase
    .from("group_members")
    .select("group_id, groups(*)")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: false });

  if (error || !memberships?.length) {
    groupsCache = [];
    renderGroups([]);
    return;
  }

  groupsCache = memberships
    .map((membership) => membership.groups)
    .filter(Boolean)
    .sort((left, right) => new Date(right.updated_at || 0) - new Date(left.updated_at || 0))
    .map((group) => ({
      ...group,
      memberCount: group.member_count || 1
    }));

  renderGroups(groupsCache);

  if (activeGroup) {
    const refreshed = groupsCache.find((group) => group.id === activeGroup.id);
    if (refreshed) {
      activeGroup = refreshed;
      renderChatHeader();
    }
  }
}

async function acceptRequest(requestId, fromUser, toUser) {
  const [userA, userB] = normalizePair(fromUser, toUser);

  const { error: friendshipError } = await supabase
    .from("friendships")
    .upsert({
      user_a: userA,
      user_b: userB,
      last_message: "",
      updated_at: new Date().toISOString()
    }, { onConflict: "user_a,user_b" });

  if (friendshipError) {
    showStatus(friendRequestStatus, friendlyError(friendshipError), true);
    return;
  }

  await supabase
    .from("friend_requests")
    .update({ status: "accepted", responded_at: new Date().toISOString() })
    .eq("id", requestId);

  await refreshRequests();
  await refreshFriendships();
}

async function declineRequest(requestId) {
  await supabase
    .from("friend_requests")
    .update({ status: "declined", responded_at: new Date().toISOString() })
    .eq("id", requestId);
}

function renderRequests(requests) {
  requestCountLabel.textContent = `${requests.length} pending`;

  if (!requests.length) {
    requestList.innerHTML = `
      <div class="empty-card">
        <strong>No pending requests</strong>
        <p>Friend requests sent to your handle will show up here.</p>
      </div>
    `;
    return;
  }

  requestList.innerHTML = "";
  requests.forEach((request) => {
    const profile = request.fromProfile || {};
    const card = document.createElement("article");
    card.className = "request-card";
    card.innerHTML = `
      <div class="account-card compact-account">
        <img class="avatar" src="${safePhoto(profile.avatar_url)}" alt="${escapeHtml(profile.display_name || "Friend")}">
        <div>
          <strong>${escapeHtml(profile.display_name || "Friend")}</strong>
          <p class="muted-copy">@${escapeHtml(profile.handle || "no-handle")}</p>
        </div>
      </div>
      <div class="request-actions">
        <button class="primary-btn accept-btn" type="button">Accept</button>
        <button class="ghost-btn decline-btn" type="button">Decline</button>
      </div>
    `;
    card.querySelector(".accept-btn").addEventListener("click", () => acceptRequest(request.id, request.from_user, request.to_user));
    card.querySelector(".decline-btn").addEventListener("click", () => declineRequest(request.id));
    requestList.appendChild(card);
  });
}

function renderFriends(friends) {
  friendCountLabel.textContent = `${friends.length} ${friends.length === 1 ? "friend" : "friends"}`;

  if (!friends.length) {
    friendsList.innerHTML = `
      <div class="empty-card">
        <strong>No friends yet</strong>
        <p>Send a handle request and accept one to start chatting.</p>
      </div>
    `;
    return;
  }

  friendsList.innerHTML = "";
  friends.forEach((friendship) => {
    const friend = friendship.friendProfile || {};
    const button = document.createElement("button");
    button.type = "button";
    button.className = `friend-card${friendship.id === activeFriendship?.id ? " active" : ""}`;
    button.innerHTML = `
      <div class="friend-card-head">
        <div class="account-card compact-account">
          <img class="avatar" src="${safePhoto(friend.avatar_url)}" alt="${escapeHtml(friend.display_name || "Friend")}">
          <div>
            <strong>${escapeHtml(friend.display_name || "Friend")}</strong>
            <p>@${escapeHtml(friend.handle || "no-handle")}</p>
          </div>
        </div>
      </div>
      <div class="friend-card-meta">
        <small>${escapeHtml(friendship.last_message || "No messages yet")}</small>
      </div>
    `;
    button.addEventListener("click", () => openConversation(friendship));
    friendsList.appendChild(button);
  });
}

function renderGroups(groups) {
  groupCountLabel.textContent = `${groups.length} ${groups.length === 1 ? "group" : "groups"}`;

  if (!groups.length) {
    groupsList.innerHTML = `
      <div class="empty-card">
        <strong>No groups yet</strong>
        <p>Create a group with friend handles to start a shared chat.</p>
      </div>
    `;
    return;
  }

  groupsList.innerHTML = "";
  groups.forEach((group) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `friend-card${group.id === activeGroup?.id ? " active" : ""}`;
    button.innerHTML = `
      <div class="friend-card-head">
        <div>
          <strong>${escapeHtml(group.name || "Group chat")}</strong>
          <p>${group.memberCount || 1} ${(group.memberCount || 1) === 1 ? "member" : "members"}</p>
        </div>
      </div>
      <div class="friend-card-meta">
        <small>${escapeHtml(group.last_message || "No messages yet")}</small>
      </div>
    `;
    button.addEventListener("click", () => openGroup(group));
    groupsList.appendChild(button);
  });
}

async function openConversation(friendship) {
  activeConversationType = "friend";
  activeFriendship = friendship;
  activeFriendProfile = friendship.friendProfile;
  activeGroup = null;
  enableChat();
  renderChatHeader();
  await refreshMessages();
  subscribeToMessages();
  renderFriends(friendsCache);
  renderGroups(groupsCache);
}

async function openGroup(group) {
  activeConversationType = "group";
  activeGroup = group;
  activeFriendship = null;
  activeFriendProfile = null;
  enableChat();
  renderChatHeader();
  await refreshMessages();
  subscribeToMessages();
  renderFriends(friendsCache);
  renderGroups(groupsCache);
}

async function refreshMessages() {
  if (activeConversationType === "friend" && !activeFriendship) {
    return;
  }

  if (activeConversationType === "group" && !activeGroup) {
    return;
  }

  if (activeConversationType === "group") {
    const { data: messages } = await supabase
      .from("group_messages")
      .select("*")
      .eq("group_id", activeGroup.id)
      .order("created_at", { ascending: true })
      .limit(200);

    const senderIds = [...new Set((messages || []).map((message) => message.sender_id))];
    const { data: profiles } = senderIds.length
      ? await supabase.from("profiles").select("id, display_name").in("id", senderIds)
      : { data: [] };

    const profileMap = new Map((profiles || []).map((profile) => [profile.id, profile]));
    renderMessages((messages || []).map((message) => ({
      ...message,
      senderProfile: profileMap.get(message.sender_id)
    })));
    return;
  }

  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .eq("friendship_id", activeFriendship.id)
    .order("created_at", { ascending: true })
    .limit(200);

  renderMessages(messages || []);
}

async function handleSendMessage(event) {
  event.preventDefault();
  if (!currentSession?.user) {
    return;
  }

  const body = messageInput.value.trim();
  if (!body) {
    return;
  }

  const timestamp = new Date().toISOString();

  if (activeConversationType === "group") {
    if (!activeGroup) {
      return;
    }

    const { error } = await supabase.from("group_messages").insert({
      group_id: activeGroup.id,
      sender_id: currentSession.user.id,
      body,
      created_at: timestamp
    });

    if (error) {
      showStatus(groupStatus, friendlyError(error), true);
      return;
    }

    await supabase
      .from("groups")
      .update({
        last_message: body,
        updated_at: timestamp
      })
      .eq("id", activeGroup.id);

    await notifyMessage({
      kind: "group",
      conversationId: activeGroup.id,
      title: activeGroup.name || "PulseChat group",
      body
    });

    messageInput.value = "";
    autoSizeComposer();
    return;
  }

  if (!activeFriendship) {
    return;
  }

  const { error } = await supabase.from("messages").insert({
    friendship_id: activeFriendship.id,
    sender_id: currentSession.user.id,
    body,
    created_at: timestamp
  });

  if (error) {
    showStatus(friendRequestStatus, friendlyError(error), true);
    return;
  }

  await supabase
    .from("friendships")
    .update({
      last_message: body,
      updated_at: timestamp
    })
    .eq("id", activeFriendship.id);

  await notifyMessage({
    kind: "friend",
    conversationId: activeFriendship.id,
    title: currentProfile?.display_name || "PulseChat",
    body
  });

  messageInput.value = "";
  autoSizeComposer();
}

async function notifyMessage({ kind, conversationId, title, body }) {
  if (!currentSession?.access_token) {
    return;
  }

  try {
    await fetch("/api/push-notify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${currentSession.access_token}`
      },
      body: JSON.stringify({ kind, conversationId, title, body })
    });
  } catch (_error) {
    // Push is a bonus path; chat delivery should not fail if notification delivery does.
  }
}

function renderMessages(messages) {
  if (!messages.length) {
    const targetName = activeConversationType === "group"
      ? activeGroup?.name || "this group"
      : activeFriendProfile?.display_name || "your friend";
    renderEmptyChat(`Say hi to ${targetName}`, "This conversation is live, so new messages appear instantly for everyone here.");
    return;
  }

  chatMessages.innerHTML = "";
  messages.forEach((message) => {
    const isSelf = message.sender_id === currentSession?.user?.id;
    const senderName = activeConversationType === "group"
      ? message.senderProfile?.display_name || "Member"
      : activeFriendProfile?.display_name || "Friend";
    const row = document.createElement("div");
    row.className = `message-row ${isSelf ? "self" : "friend"}`;
    row.innerHTML = `
      <article class="message-bubble">
        <p>${escapeHtml(message.body || "")}</p>
        <small>${isSelf ? "You" : escapeHtml(senderName)} - ${formatTimestamp(message.created_at)}</small>
      </article>
    `;
    chatMessages.appendChild(row);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function renderChatHeader() {
  if (activeConversationType === "group" && activeGroup) {
    chatTitle.textContent = activeGroup.name || "Group chat";
    chatPresence.textContent = `${activeGroup.memberCount || 1} members`;
    chatPresence.className = "presence-pill online";
    return;
  }

  if (!activeFriendProfile) {
    chatTitle.textContent = "Select a friend";
    chatPresence.textContent = "Waiting";
    chatPresence.className = "presence-pill away";
    return;
  }

  chatTitle.textContent = activeFriendProfile.display_name || "Friend";
  chatPresence.textContent = `@${activeFriendProfile.handle || "friend"}`;
  chatPresence.className = "presence-pill online";
}

function renderSignedOut() {
  authTitle.textContent = "Sign in to start";
  authStatusPill.textContent = "Offline";
  authStatusPill.className = "presence-pill away";
  signedOutView.hidden = false;
  signedInView.hidden = true;
  displayNameInput.value = "";
  handleInput.value = "";
  disableChat();
}

function renderSignedIn(user) {
  authTitle.textContent = "Signed in";
  authStatusPill.textContent = "Online";
  authStatusPill.className = "presence-pill online";
  signedOutView.hidden = true;
  signedInView.hidden = false;
  accountAvatar.src = safePhoto(user.user_metadata?.avatar_url);
  accountName.textContent = user.user_metadata?.full_name || user.user_metadata?.name || user.email || "Signed in user";
  accountEmail.textContent = user.email || "";
}

function renderEmptyChat(title, text) {
  chatMessages.innerHTML = `
    <div class="empty-state">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function disableChat() {
  messageInput.disabled = true;
  sendMessageBtn.disabled = true;
  activeConversationType = "friend";
  activeFriendship = null;
  activeFriendProfile = null;
  activeGroup = null;
  renderChatHeader();
}

function enableChat() {
  messageInput.disabled = false;
  sendMessageBtn.disabled = false;
  if (activeConversationType === "group") {
    messageInput.placeholder = activeGroup ? `Message ${activeGroup.name || "group"}...` : "Type a message...";
    return;
  }

  messageInput.placeholder = activeFriendProfile ? `Message ${activeFriendProfile.display_name || "friend"}...` : "Type a message...";
}

function subscribeToRequests() {
  const userId = currentSession?.user?.id;
  if (!userId) {
    return;
  }

  requestsChannel = supabase
    .channel(`friend_requests:${userId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "friend_requests",
      filter: `to_user=eq.${userId}`
    }, () => {
      refreshRequests();
    })
    .subscribe();
}

function subscribeToFriendships() {
  const userId = currentSession?.user?.id;
  if (!userId) {
    return;
  }

  friendshipsChannelA = supabase
    .channel(`friendships_a:${userId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "friendships",
      filter: `user_a=eq.${userId}`
    }, () => {
      refreshFriendships();
    })
    .subscribe();

  friendshipsChannelB = supabase
    .channel(`friendships_b:${userId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "friendships",
      filter: `user_b=eq.${userId}`
    }, () => {
      refreshFriendships();
    })
    .subscribe();
}

function subscribeToGroups() {
  const userId = currentSession?.user?.id;
  if (!userId) {
    return;
  }

  groupsChannel = supabase
    .channel(`group_members:${userId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "group_members",
      filter: `user_id=eq.${userId}`
    }, () => {
      refreshGroups();
    })
    .subscribe();
}

function subscribeToAllMessageChanges() {
  if (allMessagesChannel) {
    supabase.removeChannel(allMessagesChannel);
    allMessagesChannel = null;
  }

  if (allGroupMessagesChannel) {
    supabase.removeChannel(allGroupMessagesChannel);
    allGroupMessagesChannel = null;
  }

  allMessagesChannel = supabase
    .channel(`all_messages:${currentSession.user.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages"
    }, async (payload) => {
      await refreshFriendships();
      if (activeConversationType === "friend" && payload.new?.friendship_id === activeFriendship?.id) {
        await refreshMessages();
      }
    })
    .subscribe();

  allGroupMessagesChannel = supabase
    .channel(`all_group_messages:${currentSession.user.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "group_messages"
    }, async (payload) => {
      await refreshGroups();
      if (activeConversationType === "group" && payload.new?.group_id === activeGroup?.id) {
        await refreshMessages();
      }
    })
    .subscribe();
}

function subscribeToMessages() {
  if (activeConversationType === "friend" && !activeFriendship) {
    return;
  }

  if (activeConversationType === "group" && !activeGroup) {
    return;
  }

  if (messagesChannel) {
    supabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }

  if (groupMessagesChannel) {
    supabase.removeChannel(groupMessagesChannel);
    groupMessagesChannel = null;
  }

  if (activeConversationType === "group") {
    groupMessagesChannel = supabase
      .channel(`group_messages:${activeGroup.id}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "group_messages",
        filter: `group_id=eq.${activeGroup.id}`
      }, () => {
        refreshMessages();
        refreshGroups();
      })
      .subscribe();
    return;
  }

  messagesChannel = supabase
    .channel(`messages:${activeFriendship.id}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "messages",
      filter: `friendship_id=eq.${activeFriendship.id}`
    }, () => {
      refreshMessages();
    })
    .subscribe();
}

function resetRealtimeSubscriptions() {
  if (!supabase) {
    return;
  }

  if (requestsChannel) supabase.removeChannel(requestsChannel);
  if (friendshipsChannelA) supabase.removeChannel(friendshipsChannelA);
  if (friendshipsChannelB) supabase.removeChannel(friendshipsChannelB);
  if (messagesChannel) supabase.removeChannel(messagesChannel);
  if (groupsChannel) supabase.removeChannel(groupsChannel);
  if (groupMessagesChannel) supabase.removeChannel(groupMessagesChannel);
  if (allMessagesChannel) supabase.removeChannel(allMessagesChannel);
  if (allGroupMessagesChannel) supabase.removeChannel(allGroupMessagesChannel);
  requestsChannel = null;
  friendshipsChannelA = null;
  friendshipsChannelB = null;
  messagesChannel = null;
  groupsChannel = null;
  groupMessagesChannel = null;
  allMessagesChannel = null;
  allGroupMessagesChannel = null;
}

function setConfigWarningIfNeeded() {
  if (!isSupabaseConfigured()) {
    showStatus(authError, "Supabase config is still empty. Fill pulsechat-supabase-config.js before sign-in will work.", true);
  }
}

function updateNotificationButton() {
  if (!("Notification" in window)) {
    enableNotificationsBtn.disabled = true;
    enableNotificationsBtn.textContent = "Notifications unavailable";
    return;
  }

  if (Notification.permission === "denied") {
    enableNotificationsBtn.textContent = "Notifications blocked";
    return;
  }

  enableNotificationsBtn.textContent = "Enable notifications";
}

function normalizeHandle(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9_]/g, "").slice(0, 20);
}

function normalizePair(a, b) {
  return [a, b].sort();
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function autoSizeComposer() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

function showStatus(element, text, isError = false) {
  element.hidden = false;
  element.textContent = text;
  element.className = `status-text${isError ? " error-text" : " success-text"}`;
}

function hideStatus(element) {
  element.hidden = true;
  element.textContent = "";
}

function friendlyError(error) {
  return error?.message || "Something went wrong. Check your Supabase setup and try again.";
}

function safePhoto(url) {
  return url || "https://placehold.co/80x80/f3ede4/18201b?text=P";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
