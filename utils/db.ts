import Dexie, {type Table} from 'dexie';

export class Database extends Dexie {
    history!: Table<HistoryItem>
    tab!: Table<TabItem>

    constructor() {
        super('ai')
        this.version(4).stores({
            history: '++id, session, type, role, content, src',
            tab: '++id, label'
        })
        this.version(5).stores({
            tab: '++id, label, created_at',
            history: '++id, session, type, role, content, src, created_at',
        }).upgrade(trans => {
            return trans.table('history').toCollection().modify(async (i: any) => {
                if (i.type === 'image') {
                    i.content = ''
                    i.src = Array.isArray(i.src) ? i.src : (i.src ? [i.src] : []);
                }
            })
        })
    }

    getLatestTab() {
        return DB.tab.orderBy('id').last();
    }

    getTabs() {
        return DB.tab.limit(100).reverse().toArray()
    }

    async getHistory(session: number) {
        const arr = await DB.history.where('session').equals(session).limit(100).toArray()
        arr.forEach((i: any) => {
            if (i.type === 'image') {
                i.src_url = []
                i.src?.forEach((srcItem: any) => {
                    if (srcItem instanceof Blob) {
                        i.src_url!.push(URL.createObjectURL(srcItem))
                    }
                })
                i.content = 'image'
            }
        })
        return arr
    }

    addTab(label: string) {
        return DB.tab.add({label, created_at: Date.now()})
    }

    deleteTabAndHistory(id: number) {
        return DB.transaction('rw', DB.tab, DB.history, async () => {
            await DB.tab.delete(id)
            await DB.history.where('session').equals(id).delete()
        })
    }
}

export const DB = new Database();

export const initialSettings = {
    openaiKey: '',
    image_steps: 20,
    system_prompt: 'You are Gemini 2.5 Pro, a large language model. Follow the user\'s instructions carefully. Respond using markdown.',
};

export type Settings = typeof initialSettings;

export const uniModals: Model[] = [
    {
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3.0 Pro',
        provider: 'google',
        type: 'universal'
    },
    {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        provider: 'google',
        type: 'universal'
    }
];

export const textGenModels: Model[] = [];

export const imageGenModels: Model[] = [];

export const models: Model[] = [...uniModals, ...textGenModels, ...imageGenModels];
