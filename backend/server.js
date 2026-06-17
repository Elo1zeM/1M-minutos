if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config(); 
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Conexão com o Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Servir arquivos do frontend de forma estática
app.use(express.static(path.join(__dirname, '../frontend')));

// Middleware para extrair o RM/Identificação enviado pelo Front
function extrairRM(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader) {
        req.aluno_rm = authHeader.split(' ')[1];
    }
    next();
}
app.use(extrairRM);

// ==========================================
// ROTAS DA API
// ==========================================

// 1. Rota de Cadastro de Aluno (Para o cadastro.html)
app.post('/api/auth/register', async (req, res) => {
    const { nome, rm, senha, estado, unidade, turma } = req.body;
    
    try {
        if (!nome || !rm || !senha || !estado || !unidade || !turma) {
            return res.status(400).json({ success: false, message: 'Por favor, preencha todos os campos obrigatórios.' });
        }

        // Criptografa a senha antes de salvar
        const senha_hash = await bcrypt.hash(senha, 10);

        // Regra para e-mail obrigatório
        const emailFinal = rm.includes('@') ? rm : `${rm}@sesisenai.br`;

        // Insere na tabela 'alunos' usando os novos campos diretos de texto
        const { data, error } = await supabase
            .from('alunos')
            .insert([{ 
                rm: rm, 
                nome: nome, 
                email: emailFinal, 
                senha_hash: senha_hash, 
                estado: estado, 
                unidade: unidade, 
                turma: turma 
            }]);

        if (error) {
            if (error.code === '23505') {
                return res.status(400).json({ success: false, message: 'Este RM ou E-mail já está cadastrado.' });
            }
            throw error;
        }

        res.json({ success: true, message: 'Aluno cadastrado com sucesso!' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 2. Perfil do Aluno (Puxa direto da tabela alunos)
app.get('/api/aluno/perfil', async (req, res) => {
    const rm = req.aluno_rm;
    if (!rm) return res.status(401).json({ success: false, message: 'Não autenticado' });

    try {
        const { data, error } = await supabase
            .from('alunos')
            .select('rm, nome, email, unidade, turma, estado')
            .eq('rm', rm)
            .single();

        if (error || !data) throw error || new Error('Aluno não encontrado');
        
        res.json({
            success: true,
            aluno: {
                nome: data.nome,
                unidade_escolar: data.unidade || 'Não informada',
                turma: data.turma || 'Sem Turma',
                estado: data.estado
            }
        });
    } catch (error) {
        res.status(404).json({ success: false, error: error.message });
    }
});

// 3. Meta da Escola (Soma de todos os minutos lidos)
app.get('/api/leitura/total-escola', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('historico_leitura')
            .select('minutos_lidos');

        if (error) throw error;

        const totalMinutosEscola = data ? data.reduce((sum, item) => sum + item.minutos_lidos, 0) : 0;
        const metaEscola = 1000000;
        const porcentagem = ((totalMinutosEscola / metaEscola) * 100).toFixed(1);

        res.json({
            success: true,
            meta: metaEscola,
            totalMinutos: totalMinutosEscola,
            porcentagem: parseFloat(porcentagem)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Progresso Individual e Histórico
app.get('/api/leitura/progresso-individual', async (req, res) => {
    const rm = req.aluno_rm;
    if (!rm) return res.status(401).json({ success: false, message: 'Não autenticado' });

    try {
        const { data, error } = await supabase
            .from('historico_leitura')
            .select('minutos_lidos, data_registro')
            .eq('aluno_rm', rm)
            .order('data_registro', { ascending: true });

        if (error) throw error;

        const totalHistorico = data ? data.reduce((sum, item) => sum + item.minutos_lidos, 0) : 0;

        res.json({
            success: true,
            totalHistorico: totalHistorico,
            ofensiva: data && data.length > 0 ? 5 : 0, 
            historicoSemanal: data || []
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Rota para obter Ranking de Turmas (Correção de Vínculo entre Tabelas)
app.get('/api/leitura/ranking-turmas', async (req, res) => {
    try {
        // 1. Puxa todo o histórico de leitura
        const { data: historicos, error: errHist } = await supabase
            .from('historico_leitura')
            .select('aluno_rm, minutos_lidos');

        if (errHist) throw errHist;

        // 2. Puxa a lista completa de alunos para cruzar as informações
        const { data: alunos, error: errAlunos } = await supabase
            .from('alunos')
            .select('rm, turma, unidade_escolar, estado');

        if (errAlunos) throw errAlunos;

        // Cria um mapa de alunos usando o RM como chave rápida de busca
        const mapaAlunos = {};
        alunos.forEach(aluno => {
            mapaAlunos[aluno.rm] = aluno;
        });

        // 3. Agrupa as leituras combinando Turma + Unidade + Estado
        const agrupado = {};
        
        historicos.forEach(item => {
            // Encontra o aluno dono desse registro de leitura
            const aluno = mapaAlunos[item.aluno_rm];
            
            if (aluno) {
                const turmaNome = aluno.turma || 'Sem Turma';
                const unidade = aluno.unidade_escolar || 'SESI';
                const estado = aluno.estado || 'SP';
                
                // Cria a chave para diferenciar as escolas
                const chaveUnica = `${turmaNome}|${unidade}|${estado}`;

                if (!agrupado[chaveUnica]) {
                    agrupado[chaveUnica] = {
                        turma: turmaNome,
                        unidade_escolar: unidade,
                        estado: estado,
                        total_minutos: 0
                    };
                }
                agrupado[chaveUnica].total_minutos += item.minutos_lidos;
            }
        });

        // 4. Transforma em lista e ordena do maior para o menor
        const rankingOrdenado = Object.values(agrupado)
            .sort((a, b) => b.total_minutos - a.total_minutos);

        res.json({ success: true, ranking: rankingOrdenado });
    } catch (error) {
        console.error("Erro na rota de ranking:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 5. Rota para obter Ranking de Turmas (Com diagnóstico de colunas)
app.get('/api/leitura/ranking-turmas', async (req, res) => {
    try {
        // 1. Puxa todo o histórico de leitura
        const { data: historicos, error: errHist } = await supabase
            .from('historico_leitura')
            .select('*'); // Puxa tudo para não errarmos o nome da coluna

        if (errHist) throw errHist;

        // 2. Puxa a lista completa de alunos
        const { data: alunos, error: errAlunos } = await supabase
            .from('alunos')
            .select('*'); // Puxa tudo para não errarmos o nome da coluna

        if (errAlunos) throw errAlunos;

        // ================= DIAGNÓSTICO NO TERMINAL DA VERCEL =================
        console.log("=== DIAGNÓSTICO DE DADOS ===");
        console.log("Primeiro registro do histórico:", historicos[0]);
        console.log("Primeiro registro de alunos:", alunos[0]);
        // =====================================================================

        // Cria um mapa de alunos testando variações comuns de coluna (rm, RM, id)
        const mapaAlunos = {};
        alunos.forEach(aluno => {
            const rmChave = aluno.rm || aluno.RM || aluno.id;
            if (rmChave) {
                mapaAlunos[rmChave] = aluno;
            }
        });

        const agrupado = {};
        
        historicos.forEach(item => {
            // Tenta adivinhar qual coluna guarda o RM do aluno no histórico de leitura
            const rmDoHistorico = item.aluno_rm || item.rm_aluno || item.aluno_id || item.rm || item.RM;
            const aluno = mapaAlunos[rmDoHistorico];
            
            if (aluno) {
                const turmaNome = aluno.turma || aluno.Turma || 'Sem Turma';
                const unidade = aluno.unidade_escolar || aluno.unidade || 'SESI';
                const estado = aluno.estado || aluno.uf || 'SP';
                const minutos = item.minutos_lidos || item.minutos || 0;
                
                const chaveUnica = `${turmaNome}|${unidade}|${estado}`;

                if (!agrupado[chaveUnica]) {
                    agrupado[chaveUnica] = {
                        turma: turmaNome,
                        unidade_escolar: unidade,
                        estado: estado,
                        total_minutos: 0
                    };
                }
                agrupado[chaveUnica].total_minutos += minutos;
            }
        });

        const rankingOrdenado = Object.values(agrupado)
            .sort((a, b) => b.total_minutos - a.total_minutos);

        res.json({ success: true, ranking: rankingOrdenado });
    } catch (error) {
        console.error("Erro crítico na rota de ranking:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 6. Rota de Login (Para o login.html)
app.post('/api/auth/login', async (req, res) => {
    const { rm, senha } = req.body;
    try {
        // Busca o aluno permitindo autenticação pelo campo RM (que guarda email ou rm)
        const { data: aluno, error } = await supabase
            .from('alunos')
            .select('*')
            .eq('rm', rm)
            .single();

        if (error || !aluno) {
            return res.status(400).json({ success: false, message: 'RM ou senha incorretos!' });
        }

        const senhaValida = await bcrypt.compare(senha, aluno.senha_hash);
        if (!senhaValida) {
            return res.status(400).json({ success: false, message: 'RM ou senha incorretos!' });
        }

        res.json({ 
            success: true, 
            message: 'Login realizado com sucesso!',
            aluno: { rm: aluno.rm, nome: aluno.nome }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 7. Rota para Registrar Minutos Lidos (Tratamento de Erros Otimizado)
app.post('/api/leitura/registrar', async (req, res) => {
    const { minutos } = req.body;
    const rm = req.aluno_rm; 

    if (!rm) return res.status(401).json({ success: false, message: 'Não autenticado' });
    if (!minutos || minutos <= 0) return res.status(400).json({ success: false, message: 'Quantidade de minutos inválida' });

    try {
        const { data, error } = await supabase
            .from('historico_leitura')
            .insert([{ aluno_rm: rm, minutos_lidos: parseInt(minutos) }]);

        if (error) throw error;

        res.json({ success: true, message: 'Minutos registrados com sucesso!' });
    } catch (error) {
        // Retorna message explicitamente para o front-end não exibir 'undefined'
        res.status(500).json({ success: false, message: error.message || 'Erro interno no banco de dados.' });
    }
});

// Servir arquivos de forma estática garantindo caminho absoluto
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Rota padrão compatível com as regras rígidas do Express 5 / path-to-regexp
app.get(/^.*$/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor ativo na porta ${PORT}`));

module.exports = app;